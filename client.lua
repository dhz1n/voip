local Proxy = module("vrp","lib/Proxy")
vRP = Proxy.getInterface("vRP")
----------------------------------------------------------------------------------
--[[LOCAIS]]
----------------------------------------------------------------------------------
local proximidade = 15.0 -- proximidade padrao
local proximidadev = 5.0 -- proximidade veiculo
local proximidaded = 9.0 -- proximidade dentro de algum lugar
local delayptk = 500 -- delay do push to talk
local ratelistener = 15 -- taxa de atualizacao da posicao do ouvinte
local listeneronply = false -- coloca o som no player ao inves da posicao da camera
----------------------------------------------------------------------------------
--[[METODOS]]
----------------------------------------------------------------------------------
channel_callbacks = {}
voice_channels = {}
vrp_voip = false
voip_interval = 5000
voip_proximity = 100 
active_channels = {}
speaking = false
listener_wait = math.ceil(1/ratelistener*1000)
----------------------------------------------------------------------------------
--[[THREADS]]
----------------------------------------------------------------------------------
Citizen.CreateThread(function()
  while true do
    Citizen.Wait(listener_wait)

    local x,y,z
    if listeneronply then
      local ped = GetPlayerPed(PlayerId())
      x,y,z = table.unpack(GetPedBoneCoords(ped, 31086, 0,0,0))
    else
      x,y,z = table.unpack(GetGameplayCamCoord())
    end

    local fx,fy,fz = vRP.getCamDirection()
    SendNUIMessage({act="audio_listener", x = x, y = y, z = z, fx = fx, fy = fy, fz = fz})
  end
end)

local Tunnel = module("vrp","lib/Tunnel")
DHVoIP = Tunnel.getInterface("dhz1n_voip")

Citizen.CreateThread(function()
  local n = 0
  local ns = math.ceil(voip_interval/listener_wait)
  local connections = {}

  while true do
    Citizen.Wait(listener_wait)

    n = n+1
    local voip_check = (n >= ns)
    if voip_check then n = 0 end

    local pid = PlayerId()
    local spid = GetPlayerServerId(pid)
    local px,py,pz = vRP.getPosition()

    local positions = {}

    local players = DHVoIP.players()
    for k,v in pairs(players) do
      local player = GetPlayerFromServerId(k)

      if NetworkIsPlayerConnected(player) or player == pid then
        local oped = GetPlayerPed(player)
        local x,y,z = table.unpack(GetPedBoneCoords(oped, 31086, 0,0,0))
        positions[k] = {x,y,z}

        if player ~= pid and vrp_voip and voip_check then
          local distance = DHVoIP.distance(x,y,z,px,py,pz)
          local in_radius = (distance <= voip_proximity)
          if not connections[k] and in_radius then
            connectVoice("world", k)
            connections[k] = true
          elseif connections[k] and not in_radius then
            disconnectVoice("world", k)
            connections[k] = nil
          end
        end
      end
    end

    positions._ = true
    SendNUIMessage({act="set_player_positions", positions=positions})
  end
end)

Citizen.CreateThread(function()
  while true do
    Citizen.Wait(0)

    local old_speaking = speaking
    speaking = IsControlPressed(1,249)

    if old_speaking ~= speaking then
      if not speaking then
        speaking = true
        SetTimeout(delayptk+1, function()
          if speaking_time and GetGameTimer()-speaking_time >= delayptk then
            speaking = false
            TriggerEvent("speakingChange", speaking)
            speaking_time = nil
          end
        end)
      else
        TriggerEvent("speakingChange", speaking)
        speaking_time = GetGameTimer()
      end
    end
  end
end)

Citizen.CreateThread(function()
  while true do
    Citizen.Wait(500)
    if vrp_voip then
      NetworkSetTalkerProximity(voip_proximity)
    else
      local ped = GetPlayerPed(-1)
      local proximity = proximidade

      if IsPedSittingInAnyVehicle(ped) then
        local veh = GetVehiclePedIsIn(ped,false)
        local hash = GetEntityModel(veh)

        if IsThisModelACar(hash) or IsThisModelAHeli(hash) or IsThisModelAPlane(hash) then
          proximity = proximidadev
        end
      elseif vRP.isInside() then
        proximity = proximidaded
      end

      NetworkSetTalkerProximity(proximity+0.0001)
    end
  end
end)
----------------------------------------------------------------------------------
--[[FUNCTIONS]]
----------------------------------------------------------------------------------
function connectVoice(channel, player)
  SendNUIMessage({act="connect_voice", channel=channel, player=player})
end

function disconnectVoice(channel, player)
  SendNUIMessage({act="disconnect_voice", channel=channel, player=player})
end

function setVoiceState(channel, active)
  SendNUIMessage({act="set_voice_state", channel=channel, active=active})
end

function isSpeaking()
  return speaking
end
----------------------------------------------------------------------------------
--[[EVENTS]]
----------------------------------------------------------------------------------
AddEventHandler('speakingChange', function(speaking)
  if vrp_voip then
    setVoiceState("world", speaking)
  end
end)

AddEventHandler('voiceChannelTransmittingChange', function(channel, transmitting)
  local old_state = (next(active_channels) ~= nil)

  if transmitting then
    active_channels[channel] = true
  else
    active_channels[channel] = nil
  end

  local state = next(active_channels) ~= nil
  if old_state ~= state then
    SetPlayerTalkingOverride(PlayerId(), state)
  end
end)

AddEventHandler('voiceChannelPlayerSpeakingChange', function(channel, player, speaking)
  if channel == "world" then
    SetPlayerTalkingOverride(GetPlayerFromServerId(player), speaking)
  end
end)
----------------------------------------------------------------------------------
--[[TUNNEL]]
----------------------------------------------------------------------------------
local Tunnel = module("vrp","lib/Tunnel")

vRPVoip = {}
Tunnel.bindInterface("dhz1n_voip",vRPVoip)
Proxy.addInterface("dhz1n_voip",vRPVoip)

function vRPVoip.configureVoIP(config, voipzin, interval, proximity)
  vrp_voip = voipzin
  voip_interval = interval
  voip_proximity = proximity

  if vrp_voip then
    NetworkSetVoiceChannel(config.id)
  end

  SendNUIMessage({act="configure_voip", config = config})
end
----------------------------------------------------------------------------------
--[[NUI CALLBACKS]]
----------------------------------------------------------------------------------
RegisterNUICallback("audio",function(data,cb)
  if data.act == "voice_channel_player_speaking_change" then
    TriggerEvent("voiceChannelPlayerSpeakingChange", data.channel, tonumber(data.player), data.speaking)
  elseif data.act == "voice_channel_transmitting_change" then
    TriggerEvent("voiceChannelTransmittingChange", data.channel, data.transmitting)
  end
end)