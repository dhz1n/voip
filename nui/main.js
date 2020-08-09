window.addEventListener("load",function(){
  var aengine = new AudioEngine();

  window.addEventListener("message",function(evt){
    var data = evt.data;
    //VoIP
    if(data.act == "audio_listener")
      aengine.setListenerData(data);
    else if(data.act == "configure_voip")
      aengine.configureVoIP(data);
    else if(data.act == "connect_voice")
      aengine.connectVoice(data);
    else if(data.act == "disconnect_voice")
      aengine.disconnectVoice(data);
    else if(data.act == "set_voice_state")
      aengine.setVoiceState(data);
    else if(data.act == "configure_voice")
      aengine.configureVoice(data);
    else if(data.act == "set_player_positions")
      aengine.setPlayerPositions(data);
  });
});
