export interface Gcj02Point {
  latitude: number
  longitude: number
}

/** Mainland-China WGS84 -> GCJ02 conversion for browser GPS coordinates. */
const PI = Math.PI
function outOfChina(lat: number, lng: number) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271
}
function transformLat(x: number, y: number) {
  let r = -100 + 2*x + 3*y + 0.2*y*y + 0.1*x*y + 0.2*Math.sqrt(Math.abs(x))
  r += (20*Math.sin(6*x*PI) + 20*Math.sin(2*x*PI))*2/3
  r += (20*Math.sin(y*PI) + 40*Math.sin(y/3*PI))*2/3
  r += (160*Math.sin(y/12*PI) + 320*Math.sin(y*PI/30))*2/3
  return r
}
function transformLng(x: number, y: number) {
  let r = 300 + x + 2*y + 0.1*x*x + 0.1*x*y + 0.1*Math.sqrt(Math.abs(x))
  r += (20*Math.sin(6*x*PI) + 20*Math.sin(2*x*PI))*2/3
  r += (20*Math.sin(x*PI) + 40*Math.sin(x/3*PI))*2/3
  r += (150*Math.sin(x/12*PI) + 300*Math.sin(x/30*PI))*2/3
  return r
}
export function wgs84ToGcj02(latitude: number, longitude: number): Gcj02Point {
  if (outOfChina(latitude, longitude)) return { latitude, longitude }
  const rad = latitude / 180 * PI
  const sin = Math.sin(rad)
  const magic = 1 - 0.00669342162296594323 * sin * sin
  const sqrt = Math.sqrt(magic)
  const dlat = transformLat(longitude - 105, latitude - 35) * 180 /
    ((6335552.717000426 / (magic * sqrt)) * PI)
  const dlng = transformLng(longitude - 105, latitude - 35) * 180 /
    ((6378245 / sqrt * Math.cos(rad)) * PI)
  return { latitude: latitude + dlat, longitude: longitude + dlng }
}

