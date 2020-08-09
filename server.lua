----------------------------------------------------------------------------------
--[[LOCAIS]]
----------------------------------------------------------------------------------
local servidor = "ws://localhost:40120"
local vbitrate = 24000 -- taxa de bits do webrtc
local framesz = 60 -- maior = menor qualidade, porem menor sobrecarga do webrtc
local vrp_voip = true -- true desabilita o voip padrao do fivem
local voip_proximity = 15 -- proximidade padrao do voip
local voip_interval = 5000 -- intervalo de conexao e desconexao do voip
voipglobal = {effects = {spatialization = { max_dist = voip_proximity, ref_dist = 3 }}} -- CANAL GLOBAL
----------------------------------------------------------------------------------
--[[METODOS]]
----------------------------------------------------------------------------------
reg_channels = {}
----------------------------------------------------------------------------------
--[[FUNCTIONS]]
----------------------------------------------------------------------------------
function registerVoiceChannel(id, config)
  if not reg_channels[id] then
    reg_channels[id] = config
  else
    error("CANAL \""..id.."\" JA REGISTRADO")
  end
end

async(function()
  registerVoiceChannel("world", voipglobal)
end)

function getChannels()
  if not channels then
    channels = {}

    local list = {}

    for id, config in pairs(reg_channels) do
      table.insert(list, {id, config})
    end

    table.sort(list, function(a,b) return a[1] < b[1] end)

    for idx, el in ipairs(list) do
      channels[el[1]] = {idx, el[2]}
    end
  end

  return channels
end
----------------------------------------------------------------------------------
--[[VOIP]]
----------------------------------------------------------------------------------
local Tunnel = module("vrp","lib/Tunnel")
vRPVoip = Tunnel.getInterface("dhz1n_voip")

AddEventHandler('vRP:playerSpawn', function(user_id, source, first_spawn)
  if first_spawn then
    vRPVoip._configureVoIP(source, {bitrate = vbitrate, frame_size = framesz, server = servidor, channels = getChannels(), id = source}, vrp_voip, voip_interval, voip_proximity)
  end
end)



-----------------------------------------
--INFINITY IMPLEMENTATION
-----------------------------------------
DHVoIP = {}
Tunnel.bindInterface("dhz1n_voip",DHVoIP)

function DHVoIP.players()
  return GetPlayers()
end

function DHVoIP.distance(x,y,z, px,py,pz)
  return #(vector3(x,y,z) - vector3(px,py,pz))
end