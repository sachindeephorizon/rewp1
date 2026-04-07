import { forwardRef } from 'react';
import { View, StyleSheet } from 'react-native';
import { WebView } from 'react-native-webview';

const BOX_OFFSET = 0.008;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const getBounds = (lat, lng) => {
  const minLat = clamp(lat - BOX_OFFSET, -85, 85);
  const maxLat = clamp(lat + BOX_OFFSET, -85, 85);
  const minLng = clamp(lng - BOX_OFFSET, -180, 180);
  const maxLng = clamp(lng + BOX_OFFSET, -180, 180);
  return { minLat, maxLat, minLng, maxLng };
};

const buildEmbedUrl = (lat, lng) => {
  const { minLat, maxLat, minLng, maxLng } = getBounds(lat, lng);
  const bbox = `${minLng}%2C${minLat}%2C${maxLng}%2C${maxLat}`;
  return `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${lat}%2C${lng}`;
};

const buildMapHTML = (lat, lng) => `
<!DOCTYPE html>
<html>
  <head>
    <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: 100%; height: 100%; overflow: hidden; background: #e5edf5; }
      #map { width: 100%; height: 100%; border: 0; }
    </style>
  </head>
  <body>
    <iframe
      id="map"
      title="OpenStreetMap"
      src="${buildEmbedUrl(lat, lng)}"
      loading="lazy"
      referrerpolicy="no-referrer-when-downgrade"
    ></iframe>
    <script>
      function clamp(value, min, max) { return Math.min(Math.max(value, min), max); }
      function buildUrl(lat, lng) {
        var offset = ${BOX_OFFSET};
        var minLat = clamp(lat - offset, -85, 85);
        var maxLat = clamp(lat + offset, -85, 85);
        var minLng = clamp(lng - offset, -180, 180);
        var maxLng = clamp(lng + offset, -180, 180);
        var bbox = minLng + '%2C' + minLat + '%2C' + maxLng + '%2C' + maxLat;
        return 'https://www.openstreetmap.org/export/embed.html?bbox=' + bbox + '&layer=mapnik&marker=' + lat + '%2C' + lng;
      }

      function syncState(data) {
        if (!data || data.t !== 'state') return;
        document.getElementById('map').src = buildUrl(data.a, data.o);
      }

      document.addEventListener('message', function(event) {
        try { syncState(JSON.parse(event.data)); } catch (err) {}
      });

      window.addEventListener('message', function(event) {
        try { syncState(JSON.parse(event.data)); } catch (err) {}
      });
    </script>
  </body>
</html>`;

const MiniMap = forwardRef(({ latitude, longitude }, ref) => (
  <View style={s.wrap}>
    <WebView
      ref={ref}
      source={{ html: buildMapHTML(latitude, longitude) }}
      style={s.webview}
      scrollEnabled={false}
      javaScriptEnabled
      originWhitelist={['*']}
    />
  </View>
));

const s = StyleSheet.create({
  wrap: {
    height: 150,
    borderRadius: 10,
    overflow: 'hidden',
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    backgroundColor: '#E5EDF5',
  },
  webview: {
    flex: 1,
    backgroundColor: 'transparent',
  },
});

export default MiniMap;
