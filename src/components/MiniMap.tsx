import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { View, StyleSheet } from 'react-native';
import { WebView } from 'react-native-webview';

interface LatLng {
  lat: number;
  lng: number;
}

interface MiniMapProps {
  latitude: number;
  longitude: number;
  destination?: LatLng | null;
  route?: LatLng[] | null;
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
.gm-red-dot{width:14px;height:14px;background:#EF4444;border:2px solid #fff;border-radius:50%;box-shadow:0 1px 4px rgba(0,0,0,0.35)}
</style>
</head><body><div id="m"></div><script>
var map=L.map('m',{zoomControl:false,attributionControl:false}).setView([${lat},${lng}],17);
L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',{maxZoom:20,subdomains:'abcd'}).addTo(map);
var dot=L.divIcon({className:'',html:'<div class="gm-dot"><div class="gm-dot-ring"></div><div class="gm-dot-core"></div></div>',iconSize:[16,16],iconAnchor:[8,8]});
var destIcon=L.divIcon({className:'',html:'<div class="gm-red-dot"></div>',iconSize:[14,14],iconAnchor:[7,7]});
var mk=L.marker([${lat},${lng}],{icon:dot}).addTo(map);
var routeLine=null;
var destMarker=null;
var hasDest=false;

// Auto-follow state. The map keeps the user centered, but if they drag it
// manually we pause auto-follow for FOLLOW_RESUME_MS so they can look around.
// Pinch-zoom is *not* counted as a pan — we always preserve their zoom level.
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

function clearRoute(){if(routeLine){map.removeLayer(routeLine);routeLine=null;}if(destMarker){map.removeLayer(destMarker);destMarker=null;}}
function onMsg(e){try{var d=JSON.parse(e.data);
  if(d.t==='loc'){
    var ll=[d.a,d.o];
    mk.setLatLng(ll);
    // Always keep the user centered (preserving whatever zoom they pinched
    // to), but pause briefly after a manual drag so they can look around.
    if(canAutoFollow()){recenterTo(ll);}
  }
  if(d.t==='route'){
    clearRoute();
    if(d.dest){
      hasDest=true;
      destMarker=L.marker([d.dest.lat,d.dest.lng],{icon:destIcon}).addTo(map);
      var pts=(d.route&&d.route.length>1)?d.route.map(function(p){return [p.lat,p.lng]}):[[mk.getLatLng().lat,mk.getLatLng().lng],[d.dest.lat,d.dest.lng]];
      routeLine=L.polyline(pts,{color:'#2563EB',weight:5,opacity:0.9,lineCap:'round',lineJoin:'round'}).addTo(map);
      try{
        programmaticMove=true;
        map.fitBounds(routeLine.getBounds(),{padding:[30,30],maxZoom:17});
        setTimeout(function(){programmaticMove=false;},650);
      }catch(_){}
      // Reset the manual-drag pause so follow re-engages on the next GPS tick.
      lastUserDragAt=0;
    }
  }
  if(d.t==='routeUpdate'){
    // Same destination, just shrink the polyline as the user advances. Do NOT
    // re-fit bounds — that would cause the map to "jump" on every GPS tick.
    if(routeLine&&d.route&&d.route.length>1){
      routeLine.setLatLngs(d.route.map(function(p){return [p.lat,p.lng]}));
    }
  }
  if(d.t==='clearRoute'){hasDest=false;clearRoute();}
}catch(x){}}
document.addEventListener('message',onMsg);
window.addEventListener('message',onMsg);
<\/script></body></html>`;

/**
 * Small OpenStreetMap with a blue dot.
 * Update position via ref: ref.current.postMessage(JSON.stringify({ t:'loc', a:lat, o:lng }))
 * Set a destination + route via the `destination` / `route` props — these are
 * pushed to the embedded map without reloading the WebView.
 */
const MiniMap = forwardRef<WebView, MiniMapProps>(({ latitude, longitude, destination, route }, ref) => {
  const innerRef = useRef<WebView>(null);
  useImperativeHandle(ref, () => innerRef.current as WebView);

  // Build the HTML exactly ONCE, with the first known coordinates. After that
  // the WebView is never reloaded — we update everything via postMessage so
  // the map doesn't flicker / re-zoom on every GPS tick.
  const initialCoordsRef = useRef({ lat: latitude, lng: longitude });
  const html = useMemo(
    () => buildMapHTML(initialCoordsRef.current.lat, initialCoordsRef.current.lng),
    []
  );

  // Push live location updates to the embedded map.
  useEffect(() => {
    innerRef.current?.postMessage(
      JSON.stringify({ t: 'loc', a: latitude, o: longitude })
    );
  }, [latitude, longitude]);

  // Track which destination is currently drawn so we can tell whether a route
  // change is "new destination" (re-fit bounds) or "same dest, shrunk line"
  // (just update the polyline points without moving the camera).
  const drawnDestRef = useRef<LatLng | null>(null);

  useEffect(() => {
    const wv = innerRef.current;
    if (!wv) return;

    if (!destination) {
      drawnDestRef.current = null;
      wv.postMessage(JSON.stringify({ t: 'clearRoute' }));
      return;
    }

    const drawn = drawnDestRef.current;
    const isSameDest =
      drawn && drawn.lat === destination.lat && drawn.lng === destination.lng;

    if (!isSameDest) {
      drawnDestRef.current = { lat: destination.lat, lng: destination.lng };
      wv.postMessage(
        JSON.stringify({
          t: 'route',
          dest: { lat: destination.lat, lng: destination.lng },
          route: route || null,
        })
      );
    } else if (route) {
      wv.postMessage(JSON.stringify({ t: 'routeUpdate', route }));
    }
  }, [destination?.lat, destination?.lng, route]);

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
