import { View, Text, StyleSheet } from 'react-native';

export default function Row({ label, value, valueColor }) {
  return (
    <View style={s.row}>
      <Text style={s.label}>{label}</Text>
      <Text style={[s.value, valueColor && { color: valueColor }]}>{value}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: '#F1F5F9' },
  label: { fontSize: 12, color: '#64748B', fontWeight: '500' },
  value: { fontSize: 12, fontWeight: '700', color: '#1E293B' },
});
