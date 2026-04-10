import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { View, StyleSheet } from 'react-native';
import { WebView } from 'react-native-webview';

interface MiniMapProps {
  latitude: number;
  longitude: number;
}

const buildMapHTML = (lat: number, lng: number): string => `
<!DOCTYPE html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"><\/script>
<style>*{margin:0;padding:0}html,body,#m{width:100%;height:100%;touch-action:none;-ms-touch-action:none}
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

var FOLLOW_RESUME_MS=5000;
var programmaticMove=false;
var lastUserDragAt=0;
map.on('dragstart',function(){if(!programmaticMove)lastUserDragAt=Date.now();});
function canAutoFollow(){return (Date.now()-lastUserDragAt)>FOLLOW_RESUME_MS;}
function recenterTo(ll){
  programmaticMove=true;
  map.panTo(ll,{animate:true,duration:0.5});
  setTimeout(function(){programmaticMove=false;},650);
}

function onMsg(e){try{var d=JSON.parse(e.data);
  if(d.t==='loc'){
    var ll=[d.a,d.o];
    mk.setLatLng(ll);
    if(canAutoFollow()){recenterTo(ll);}
  }
}catch(x){}}
document.addEventListener('message',onMsg);
window.addEventListener('message',onMsg);
<\/script></body></html>`;

/**
 * Small OpenStreetMap with a blue dot.
 * Update position via postMessage — no route/polyline rendering.
 * Route display is handled by the dashboard.
 */
const MiniMap = forwardRef<WebView, MiniMapProps>(({ latitude, longitude }, ref) => {
  const innerRef = useRef<WebView>(null);
  useImperativeHandle(ref, () => innerRef.current as WebView);

  const initialCoordsRef = useRef({ lat: latitude, lng: longitude });
  const html = useMemo(
    () => buildMapHTML(initialCoordsRef.current.lat, initialCoordsRef.current.lng),
    []
  );

  useEffect(() => {
    innerRef.current?.postMessage(
      JSON.stringify({ t: 'loc', a: latitude, o: longitude })
    );
  }, [latitude, longitude]);

  return (
    <View
      style={s.wrap}
      // Claim the touch responder so the parent ScrollView can't steal the
      // second finger of a pinch gesture. Without this, Android/iOS interpret
      // a two-finger pinch on the map as a scroll attempt and the WebView
      // never sees the gesture — the result: panning works, zooming doesn't.
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderTerminationRequest={() => false}
    >
      <WebView
        ref={innerRef}
        source={{ html }}
        style={{ flex: 1, backgroundColor: 'transparent' }}
        scrollEnabled={false}
        javaScriptEnabled
        originWhitelist={['*']}
        // Android: keeps multi-touch alive for native children inside scrollables.
        nestedScrollEnabled
        // Stop the WebView's own scroll/zoom from competing with Leaflet.
        setBuiltInZoomControls={false}
        setDisplayZoomControls={false}
      />
    </View>
  );
});

const s = StyleSheet.create({
  wrap: {
    height: 300,
    borderRadius: 10,
    overflow: 'hidden',
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#dadada',
  },
});

export default MiniMap;
