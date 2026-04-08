import { forwardRef } from 'react';
import { View, StyleSheet } from 'react-native';
import { WebView } from 'react-native-webview';

interface MiniMapProps {
  latitude: number;
  longitude: number;
}

const buildMapHTML = (lat: number, lng: number): string => `
<!DOCTYPE html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"><\/script>
<style>*{margin:0;padding:0}html,body,#m{width:100%;height:100%}
@keyframes pulse{0%{transform:scale(1);opacity:1}100%{transform:scale(5);opacity:0}}
.gm-dot{position:relative;width:16px;height:16px}
.gm-dot-core{position:absolute;top:3px;left:3px;width:10px;height:10px;background:#4285F4;border:2px solid #fff;border-radius:50%;z-index:2;box-shadow:0 1px 4px rgba(0,0,0,0.3)}
.gm-dot-ring{position:absolute;top:3px;left:3px;width:10px;height:10px;border-radius:50%;background:rgba(66,133,244,0.6);animation:pulse 1.5s ease-out infinite;z-index:1}
</style>
</head><body><div id="m"></div><script>
var map=L.map('m',{zoomControl:false,attributionControl:false}).setView([${lat},${lng}],17);
L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',{maxZoom:20,subdomains:'abcd'}).addTo(map);
var dot=L.divIcon({className:'',html:'<div class="gm-dot"><div class="gm-dot-ring"></div><div class="gm-dot-core"></div></div>',iconSize:[16,16],iconAnchor:[8,8]});
var mk=L.marker([${lat},${lng}],{icon:dot}).addTo(map);
var glow=L.polyline([],{color:'rgba(252,82,3,0.25)',weight:8,lineCap:'round',lineJoin:'round'}).addTo(map);
var trail=L.polyline([],{color:'#FC5203',weight:4,lineCap:'round',lineJoin:'round'}).addTo(map);
function onMsg(e){try{var d=JSON.parse(e.data);if(d.t==='loc'){var ll=[d.a,d.o];mk.setLatLng(ll);trail.addLatLng(ll);glow.addLatLng(ll);map.setView(ll,map.getZoom(),{animate:true,duration:0.5})}if(d.t==='clear'){trail.setLatLngs([]);glow.setLatLngs([])}}catch(x){}}
document.addEventListener('message',onMsg);
window.addEventListener('message',onMsg);
<\/script></body></html>`;

/**
 * Small OpenStreetMap with a blue dot.
 * Update position via ref: ref.current.postMessage(JSON.stringify({ t:'loc', a:lat, o:lng }))
 */
const MiniMap = forwardRef<WebView, MiniMapProps>(({ latitude, longitude }, ref) => (
  <View style={s.wrap}>
    <WebView
      ref={ref}
      source={{ html: buildMapHTML(latitude, longitude) }}
      style={{ flex: 1 }}
      scrollEnabled={false}
      javaScriptEnabled
      originWhitelist={['*']}
    />
  </View>
));

const s = StyleSheet.create({
  wrap: {
    height: 180,
    borderRadius: 10,
    overflow: 'hidden',
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#dadada',
  },
});

export default MiniMap;
