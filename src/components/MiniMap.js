import { forwardRef } from 'react';
import { View, StyleSheet } from 'react-native';
import { WebView } from 'react-native-webview';

const buildMapHTML = (lat, lng) => `
<!DOCTYPE html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"><\/script>
<style>*{margin:0;padding:0}html,body,#m{width:100%;height:100%}</style>
</head><body><div id="m"></div><script>
var map=L.map('m',{zoomControl:false,attributionControl:false}).setView([${lat},${lng}],17);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:20}).addTo(map);
var dot=L.divIcon({className:'',html:'<div style="width:16px;height:16px;background:#2563EB;border:3px solid #fff;border-radius:50%;box-shadow:0 0 0 4px rgba(37,99,235,0.25)"></div>',iconSize:[16,16],iconAnchor:[8,8]});
var mk=L.marker([${lat},${lng}],{icon:dot}).addTo(map);
document.addEventListener('message',function(e){try{var d=JSON.parse(e.data);if(d.t==='loc'){mk.setLatLng([d.a,d.o]);map.setView([d.a,d.o],map.getZoom(),{animate:true,duration:0.5})}}catch(x){}});
window.addEventListener('message',function(e){try{var d=JSON.parse(e.data);if(d.t==='loc'){mk.setLatLng([d.a,d.o]);map.setView([d.a,d.o],map.getZoom(),{animate:true,duration:0.5})}}catch(x){}});
<\/script></body></html>`;

/**
 * Small OpenStreetMap with a blue dot.
 * Update position via ref: ref.current.postMessage(JSON.stringify({ t:'loc', a:lat, o:lng }))
 */
const MiniMap = forwardRef(({ latitude, longitude }, ref) => (
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
    height: 150, borderRadius: 10, overflow: 'hidden', marginBottom: 10,
    borderWidth: 1, borderColor: '#E2E8F0',
  },
});

export default MiniMap;
