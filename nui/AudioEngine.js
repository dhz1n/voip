var clamp = function(val, min, max){ return Math.min(Math.max(min, val), max); }

function AudioEngine()
{
  var _this = this;

  this.c = new AudioContext();
  //choose processor buffer size (2^(8-14))
  this.processor_buffer_size = Math.pow(2, clamp(Math.floor(Math.log(this.c.sampleRate*0.1)/Math.log(2)), 8, 14));

  this.sources = {};
  this.player_sources = {};
  this.listener = this.c.listener;

  this.last_check = new Date().getTime();

  //VoIP
  this.voice_channels = {}; // map of idx => channel  data
  this.voice_players = {}; // map of player => global player data

  libopus.onload = function(){
   //encoder
    _this.mic_enc = new libopus.Encoder(1,48000,24000,60,true);
  }
  if(libopus.loaded) //force loading if already loaded
    libopus.onload();

  //processor
  //prepare process function
  var processOut = function(channels, samples){
    //convert to Int16 pcm
    var isamples = new Int16Array(samples.length);
    for(var i = 0; i < samples.length; i++){
      var s = samples[i];
      s *= 32768 ;
      if(s > 32767) 
        s = 32767;
      else if(s < -32768) 
        s = -32768;

      isamples[i] = s;
    }

    //encode
    _this.mic_enc.input(isamples);
    var data;
    while(data = _this.mic_enc.output()){ //generate packets
      var buffer = new Uint8Array(1+channels.length+data.length);

      // write header (channels)
      var view = new DataView(buffer.buffer);
      view.setUint8(0, channels.length);
      for(var i = 0; i < channels.length; i++)
        view.setUint8(i+1, channels[i]);

      // write audio data
      buffer.set(data, 1+channels.length);

      // send packet
      try{
        _this.voip_channel.send(buffer.buffer);
      }catch(e){}
    }
  }


  this.mic_processor = this.c.createScriptProcessor(this.processor_buffer_size,1,1);
  this.mic_processor.onaudioprocess = function(e){
    var buffer = e.inputBuffer;

    // prepare dest channels
    var channels = [];
    for(var idx in _this.voice_channels){
      var channel = _this.voice_channels[idx];
      if(channel.transmitting)
        channels.push(idx);
    }

    if(channels.length > 0){
      //resample to 48kHz if necessary
      if(buffer.sampleRate != 48000){
        var oac = new OfflineAudioContext(1,buffer.duration*48000,48000);

        var sbuff = oac.createBufferSource();
        sbuff.buffer = buffer;
        sbuff.connect(oac.destination);
        sbuff.start();

        oac.startRendering().then(function(out_buffer){
          processOut(channels, out_buffer.getChannelData(0));
        });
      }
      else 
        processOut(channels, buffer.getChannelData(0)); 
    }

    //silent output
    var out = e.outputBuffer.getChannelData(0);
    for(var k = 0; k < out.length; k++)
      out[k] = 0;

//    e.outputBuffer.copyToChannel(buffer.getChannelData(0), 0); // debug
  }

  this.mic_processor.connect(this.c.destination); //make the processor running

  //mic stream
  navigator.mediaDevices.getUserMedia({
    audio: {
      autoGainControl: true,
      echoCancellation: false,
      noiseSuppression: false,
      latency: 0
    }
  }).then(function(stream){ 
    _this.mic_node = _this.c.createMediaStreamSource(stream);
    _this.mic_comp = _this.c.createDynamicsCompressor();
    _this.mic_node.connect(_this.mic_comp);
    _this.mic_comp.connect(_this.mic_processor);
//    _this.mic_comp.connect(_this.c.destination); // debug
  });

  this.player_positions = {};

  // task: peers speaking check
  setInterval(function(){
    var time = new Date().getTime();

    for(var idx in _this.voice_channels){
      var channel = _this.voice_channels[idx];
      for(var player in channel.players){
        var peer = channel.players[player];
        if(peer.speaking && time - peer.last_packet_time >= 500){ // event
          peer.speaking = false;
          $.post("http://dhz1n_voip/audio", JSON.stringify({act: "voice_channel_player_speaking_change", channel: peer.channel, player: peer.player, speaking: peer.speaking}));
        }
      }
    }
  }, 500);
}

AudioEngine.prototype.setListenerData = function(data)
{
  this.listener.pos = [data.x, data.y, data.z];
  this.listener.setPosition(data.x, data.y, data.z);
  this.listener.setOrientation(data.fx,data.fy,data.fz,0,0,1);

  var time = new Date().getTime();
  if(time-this.last_check >= 2000){ // every 2s
    this.last_check = time;

    // pause too far away sources and unpause nearest sources paused
    for(var name in this.sources){
      var source = this.sources[name];

      if(source[3]){ //spatialized
        var dx = data.x-source[2].pos[0];
        var dy = data.y-source[2].pos[1];
        var dz = data.z-source[2].pos[2];
        var dist = Math.sqrt(dx*dx+dy*dy+dz*dz);
        var active_dist = source[2].maxDistance*2;

        if(!is_playing(source[0]) && dist <= active_dist)
          source[0].play();
        else if(is_playing(source[0]) && dist > active_dist)
          source[0].pause();
      }
    }
  }
}
//VoIP

AudioEngine.prototype.configureVoIP = function(data)
{
  var _this = this;

  this.voip_config = data.config;

  // re-create mic encoder
  if(this.mic_enc)
    this.mic_enc.destroy();
  this.mic_enc = new libopus.Encoder(1,48000,this.voip_config.bitrate,this.voip_config.frame_size,true);

  // create channels
  for(var id in this.voip_config.channels){
    var cdata = this.voip_config.channels[id];

    var idx = cdata[0];
    var config = cdata[1];

    // create channel
    var channel = {idx: idx, id: id, players: {}};
    this.voice_channels[idx] = channel;

    // build channel effects
    var effects = config.effects || {};
    var node = null;

    if(effects.biquad){ //biquad filter
      var biquad = this.c.createBiquadFilter();
      if(effects.biquad.frequency != null)
        biquad.frequency.value = effects.biquad.frequency;
      if(effects.biquad.Q != null)
        biquad.Q.value = effects.biquad.Q;
      if(effects.biquad.detune != null)
        biquad.detune.value = effects.biquad.detune;
      if(effects.biquad.gain != null)
        biquad.gain.value = effects.biquad.gain;

      if(effects.biquad.type != null)
        biquad.type = effects.biquad.type;

      if(node)
        node.connect(biquad);
      node = biquad;
      if(!channel.in_node)
        channel.in_node = node;
    }

    if(effects.gain){ //gain
      var gain = this.c.createGain();
      if(effects.gain.gain != null)
        gain.gain.value = effects.gain.gain;

      if(node)
        node.connect(gain);
      node = gain;
      if(!channel.in_node)
        channel.in_node = node;
    }

    //connect final node to output
    if(node) 
      node.connect(this.c.destination);
  }

  setInterval(function(){
    _this.connectVoIP();
  }, 10000);

  _this.connectVoIP();
}

AudioEngine.prototype.connectVoIP = function()
{
  var _this = this;

  if(!this.voip_ws || this.voip_ws.readyState == 3){
    // connect to websocket server
    this.voip_ws = new WebSocket(this.voip_config.server);

    // create peer
    this.voip_peer = new RTCPeerConnection({
      iceServers: []
    });

    this.voip_peer.onicecandidate = function(e){
      if(_this.voip_ws && _this.voip_ws.readyState == 1)
        _this.voip_ws.send(JSON.stringify({act: "candidate", data: e.candidate}));
    }

    // create channel
    this.voip_channel = this.voip_peer.createDataChannel("voip", {
      ordered: false,
      negotiated: true,
      maxRetransmits: 0,
      id: 0
    });

    this.voip_channel.binaryType = "arraybuffer";

    this.voip_channel.onopen = function(){
      console.log("Canal UDP ativado");
    }

    var feed_peers = function(pdata, channels, samples)
    {
      for(var i = 0; i < channels.length; i++){
        var peer = pdata.channels[channels[i]];
        if(peer){
          // speaking event
          peer.last_packet_time = new Date().getTime();
          if(!peer.speaking){
            peer.speaking = true;
            $.post("http://dhz1n_voip/audio", JSON.stringify({act: "voice_channel_player_speaking_change", channel: peer.channel, player: peer.player, speaking: peer.speaking}));
          }

          peer.psamples.push(samples);
        }
      }
    }

    this.voip_channel.onmessage = function(e){
      var buffer = e.data;
      var view = new DataView(buffer);

      var tplayer = view.getInt32(0);
      var nchannels = view.getUint8(4);
      var channels = new Uint8Array(buffer, 5, nchannels);

      var pdata = _this.voice_players[tplayer];

      if(pdata){
        // decode opus packet
        var raw = new Uint8Array(buffer, 5+nchannels);
        pdata.dec.input(raw);
        var data;
        while(data = pdata.dec.output()){
          // create buffer from samples
          var buffer = _this.c.createBuffer(1, data.length, 48000);
          var samples = buffer.getChannelData(0);

          for(var k = 0; k < data.length; k++){
            // convert from int16 to float
            var s = data[k];
            s /= 32767 ;
            if(s > 1) 
              s = 1;
            else if(s < -1) 
              s = -1;

            samples[k] = s;
          }

          // resample to AudioContext samplerate if necessary
          if(_this.c.sampleRate != 48000){
            var oac = new OfflineAudioContext(1,buffer.duration*_this.c.sampleRate,_this.c.sampleRate);
            var sbuff = oac.createBufferSource();
            sbuff.buffer = buffer;
            sbuff.connect(oac.destination);
            sbuff.start();

            oac.startRendering().then(function(out_buffer){
              feed_peers(pdata, channels, out_buffer.getChannelData(0));
            });
          }
          else
            feed_peers(pdata, channels, samples);
        }
      }
    }

    this.voip_ws.addEventListener("open", function(){
      console.log("Websocket do VoIP ativado");
      // identify
      _this.voip_ws.send(JSON.stringify({act: "identification", id: _this.voip_config.id}));

      // setup already connected peers
      for(var idx in _this.voice_channels){
        var channel = _this.voice_channels[idx];
        for(var player in channel.players)
          _this.voip_ws.send(JSON.stringify({act: "connect", channel: idx, player: player}));
      }
    });

    this.voip_ws.addEventListener("message", function(e){
      var data = JSON.parse(e.data);
      if(data.act == "offer"){
        _this.voip_peer.setRemoteDescription(data.data);
        _this.voip_peer.createAnswer().then(function(answer){
          _this.voip_peer.setLocalDescription(answer);
          _this.voip_ws.send(JSON.stringify({act: "answer", data: answer}));
        });
      }
      else if(data.act == "candidate" && data.data != null)
        _this.voip_peer.addIceCandidate(data.data);
    });

    this.voip_ws.addEventListener("close", function(){
      console.log("VoIP desconectado");
    })
  }
}

AudioEngine.prototype.setPlayerPositions = function(data)
{
  this.player_positions = data.positions;

  //update VoIP panners (spatialization effect)
  for(var idx in this.voice_channels){
    var channel = this.voice_channels[idx];
    for(var player in channel.players){
      var peer = channel.players[player];
      if(peer.panner){
        var pos = data.positions[player];
        if(pos){
          peer.panner.pos = pos;
          peer.panner.setPosition(pos[0], pos[1], pos[2]);
        }
      }
    }
  }

  //update player sources panners
  for(var player in this.player_positions){
    var sources = this.player_sources[player];
    if(sources){
      for(var i = 0; i < sources.length; i++){
        var source = sources[i];
        var panner = source[2];
        if(panner){
          var pos = this.player_positions[player];
          if(pos){
            var data = source[4];
            panner.pos = [pos[0]+data.x, pos[1]+data.y, pos[2]+data.z];
            panner.setPosition(pos[0]+data.x, pos[1]+data.y, pos[2]+data.z);
          }
        }
      }
    }
  }
}

AudioEngine.prototype.setupPeer = function(peer)
{
  var _this = this;

  var pdata = this.voice_players[peer.player];
  if(!pdata){
    pdata = {channels: {}};
    this.voice_players[peer.player] = pdata;

    // create decoder
    pdata.dec = new libopus.Decoder(1,48000);
  }

  // reference channel
  pdata.channels[this.getChannelIndex(peer.channel)] = peer;

  peer.psamples = []; //packets samples
  peer.processor = this.c.createScriptProcessor(this.processor_buffer_size,1,1);
  peer.processor.onaudioprocess = function(e){
    var out = e.outputBuffer.getChannelData(0);

    //feed samples to output
    var nsamples = 0;
    var i = 0;
    while(nsamples < out.length && i < peer.psamples.length){
      var p = peer.psamples[i];
      var take = Math.min(p.length, out.length-nsamples);

      //write packet samples to output
      for(var k = 0; k < take; k++){
        out[nsamples+k] = p[k];
      }

      //advance
      nsamples += take;

      if(take < p.length){ //partial samples
        //add rest packet
        peer.psamples.splice(i+1,0,p.subarray(take));
      }

      i++;
    }

    //remove processed packets
    peer.psamples.splice(0,i);

    //silent last samples
    for(var k = nsamples; k < out.length; k++)
      out[k] = 0;
  }


  //add peer effects
  var node = peer.processor;
  var config = this.voip_config.channels[peer.channel][1];
  var channel = this.voice_channels[this.getChannelIndex(peer.channel)];
  var effects = config.effects || {};

  if(effects.spatialization){ //spatialization
    var panner = this.c.createPanner();
    panner.distanceModel = effects.spatialization.dist_model || "inverse";
    panner.refDistance = effects.spatialization.ref_dist || 1;
    panner.maxDistance = effects.spatialization.max_dist;
    panner.rolloffFactor = effects.spatialization.rolloff || 1;
    panner.coneInnerAngle = 360;
    panner.coneOuterAngle = 0;
    panner.coneOuterGain = 0;

    var pos = this.player_positions[peer.player];
    if(pos){
      panner.pos = pos;
      panner.setPosition(pos[0],pos[1],pos[2]);
    }

    peer.panner = panner;

    node.connect(panner);
    node = panner;
  }

  //connect final node
  peer.final_node = node;
  node.connect(channel.in_node || this.c.destination); //connect to channel node or destination
}

AudioEngine.prototype.getChannelIndex = function(id)
{
  if(this.voip_config && this.voip_config.channels[id])
    return this.voip_config.channels[id][0];

  return -1;
}

AudioEngine.prototype.connectVoice = function(data)
{
  var channel = this.voice_channels[this.getChannelIndex(data.channel)];
  if(channel){
    if(data.player != null && !channel.players[data.player]){
      //setup new peer
      var peer = {
        channel: data.channel,
        player: data.player
      }

      channel.players[data.player] = peer;

      this.setupPeer(peer);

      if(this.voip_ws && this.voip_ws.readyState == 1)
        this.voip_ws.send(JSON.stringify({act: "connect", channel: channel.idx, player: data.player}));
    }

    this.channelTransmittingCheck(channel);
  }
}

AudioEngine.prototype.disconnectVoice = function(data)
{
  var channel = this.voice_channels[this.getChannelIndex(data.channel)];
  if(channel){
    var players = [];
    if(data.player != null)
      players.push(data.player);
    else{ //add all players
      for(var player in channel.players)
        players.push(player);
    }

    //remove peers
    for(var i = 0; i < players.length; i++){
      var player = players[i];
      var peer = channel.players[player];
      if(peer){
        if(peer.final_node) //disconnect from channel node or destination
          peer.final_node.disconnect(channel.in_node || this.c.destination);

        if(peer.speaking){ // event
          peer.speaking = false;
          $.post("http://dhz1n_voip/audio", JSON.stringify({act: "voice_channel_player_speaking_change", channel: peer.channel, player: peer.player, speaking: peer.speaking}));
        }

        // dereference channel
        var pdata = this.voice_players[player];
        if(pdata){
          delete pdata.channels[this.getChannelIndex(data.channel)];

          if(Object.keys(pdata.channels).length == 0){ // not referenced in any channels
            // remove/destroy player reference
            if(pdata.dec){
              pdata.dec.destroy();
              delete pdata.dec;
            }

            delete this.voice_players[player];
          }
        }

        if(this.voip_ws && this.voip_ws.readyState == 1)
          this.voip_ws.send(JSON.stringify({act: "disconnect", channel: channel.idx, player: player}));
      }

      delete channel.players[player];
    }

    this.channelTransmittingCheck(channel);
  }
}

AudioEngine.prototype.setVoiceState = function(data)
{
  var channel = this.voice_channels[this.getChannelIndex(data.channel)];
  if(channel){
    channel.active = data.active;

    this.channelTransmittingCheck(channel);
  }
}

AudioEngine.prototype.channelTransmittingCheck = function(channel)
{
  var old_transmitting = channel.transmitting;
  channel.transmitting = (channel.active && Object.keys(channel.players).length > 0);

  // event
  if(channel.transmitting != old_transmitting)
    $.post("http://dhz1n_voip/audio", JSON.stringify({act: "voice_channel_transmitting_change", channel: channel.id, transmitting: channel.transmitting}));
}