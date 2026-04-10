import { forwardRef, useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import { WebView } from 'react-native-webview';

interface LatLng {
  lat: number;
  lng: number;
}

interface RouteMapProps {
  origin: LatLng;
  destination: LatLng | null;
  /**
   * Optional pre-computed route coordinates (e.g. from a routing API like
   * OpenRouteService / Google Directions / Mapbox). If omitted the map will
   * draw a straight blue line between origin and destination as a placeholder.
   */
  route?: LatLng[];
  onMapPress?: (point: LatLng) => void;
}

const buildRouteHTML = (
  origin: LatLng,
  destination: LatLng | null,
  route: LatLng[] | undefined
): string => {
  const routeJson = JSON.stringify(
    (route && route.length > 0
      ? route
      : destination
        ? [origin, destination]
        : []
    ).map((p) => [p.lat, p.lng])
  );
  const destJson = destination ? JSON.stringify([destination.lat, destination.lng]) : 'null';

  return `
<!DOCTYPE html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"><\/script>
<style>
*{margin:0;padding:0}html,body,#m{width:100%;height:100%}
@keyframes pulse{0%{transform:scale(1);opacity:1}100%{transform:scale(5);opacity:0}}
.gm-dot{position:relative;width:16px;height:16px}
.gm-dot-core{position:absolute;top:3px;left:3px;width:10px;height:10px;background:#2563EB;border:2px solid #fff;border-radius:50%;z-index:2;box-shadow:0 1px 4px rgba(0,0,0,0.3)}
.gm-dot-ring{position:absolute;top:3px;left:3px;width:10px;height:10px;border-radius:50%;background:rgba(37,99,235,0.6);animation:pulse 1.5s ease-out infinite;z-index:1}
.gm-pin{width:22px;height:30px;background:#EF4444;border:2px solid #fff;border-radius:50% 50% 50% 0;transform:rotate(-45deg);box-shadow:0 2px 6px rgba(0,0,0,0.35)}
</style>
</head><body><div id="m"></div><script>
var origin=[${origin.lat},${origin.lng}];
var dest=${destJson};
var routePts=${routeJson};

var map=L.map('m',{zoomControl:true,attributionControl:false}).setView(origin,15);
L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',{maxZoom:20,subdomains:'abcd'}).addTo(map);

var startIcon=L.divIcon({className:'',html:'<div class="gm-dot"><div class="gm-dot-ring"></div><div class="gm-dot-core"></div></div>',iconSize:[16,16],iconAnchor:[8,8]});
var endIcon=L.divIcon({className:'',html:'<div class="gm-pin"></div>',iconSize:[22,30],iconAnchor:[11,28]});

L.marker(origin,{icon:startIcon}).addTo(map);

var routeLine=null;
var destMarker=null;
if(routePts.length>1){
  routeLine=L.polyline(routePts,{color:'#2563EB',weight:5,opacity:0.85,lineCap:'round',lineJoin:'round'}).addTo(map);
}
if(dest){
  destMarker=L.marker(dest,{icon:endIcon}).addTo(map);
}

if(routeLine){
  map.fitBounds(routeLine.getBounds(),{padding:[40,40]});
}else if(dest){
  map.fitBounds(L.latLngBounds([origin,dest]),{padding:[40,40]});
}

function sendToReactNative(payload){
  if(window.ReactNativeWebView&&window.ReactNativeWebView.postMessage){
    window.ReactNativeWebView.postMessage(JSON.stringify(payload));
  }
}

map.on('click',function(e){
  var lat=e.latlng.lat;
  var lng=e.latlng.lng;
  if(destMarker){ map.removeLayer(destMarker); }
  destMarker=L.marker([lat,lng],{icon:endIcon}).addTo(map);
  sendToReactNative({ t:'pick', lat:lat, lng:lng });
});
<\/script></body></html>`;
};

const RouteMap = forwardRef<WebView, RouteMapProps>(({ origin, destination, route, onMapPress }, ref) => {
  // Re-render the WebView whenever any of these change by keying source via memo
  const html = useMemo(
    () => buildRouteHTML(origin, destination, route),
    [origin.lat, origin.lng, destination?.lat, destination?.lng, route]
  );

  return (
    <View style={s.wrap}>
      <WebView
        ref={ref}
        source={{ html }}
        style={{ flex: 1 }}
        javaScriptEnabled
        originWhitelist={['*']}
        onMessage={(event) => {
          try {
            const data = JSON.parse(event.nativeEvent.data);
            if (data?.t === 'pick' && Number.isFinite(data.lat) && Number.isFinite(data.lng)) {
              onMapPress?.({ lat: data.lat, lng: data.lng });
            }
          } catch {}
        }}
      />
    </View>
  );
});

const s = StyleSheet.create({
  wrap: {
    flex: 1,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#dadada',
  },
});

export default RouteMap;
