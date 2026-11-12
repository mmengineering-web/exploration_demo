// UTM (WGS84) -> latitude/longitude. Krueger series, accurate to well under 1 mm inside a zone.
const A = 6378137, F = 1 / 298.257223563, K0 = 0.9996;
const n = F / (2 - F), n2 = n * n, n3 = n2 * n, n4 = n3 * n;
const AA = A / (1 + n) * (1 + n2 / 4 + n4 / 64);
const BETA = [n / 2 - 2 * n2 / 3 + 37 * n3 / 96 - n4 / 360, n2 / 48 + n3 / 15 - 437 * n4 / 1440, 17 * n3 / 480 - 37 * n4 / 840, 4397 * n4 / 161280];
const DELTA = [2 * n - 2 * n2 / 3 - 2 * n3 + 116 * n4 / 45, 7 * n2 / 3 - 8 * n3 / 5 - 227 * n4 / 45, 56 * n3 / 15 - 136 * n4 / 35, 4279 * n4 / 630];
const DEG = 180 / Math.PI;

export function utmToLatLon(easting, northing, zone, hemisphere = 'S') {
  const N = hemisphere === 'S' ? northing - 1e7 : northing;
  const xi = N / (K0 * AA), eta = (easting - 5e5) / (K0 * AA);
  let xi2 = xi, eta2 = eta;
  BETA.forEach((b, i) => {
    const j = 2 * (i + 1);
    xi2 -= b * Math.sin(j * xi) * Math.cosh(j * eta);
    eta2 -= b * Math.cos(j * xi) * Math.sinh(j * eta);
  });
  const chi = Math.asin(Math.sin(xi2) / Math.cosh(eta2));
  let lat = chi;
  DELTA.forEach((d, i) => { lat += d * Math.sin(2 * (i + 1) * chi); });
  const lon0 = (zone - 1) * 6 - 180 + 3;
  const lon = lon0 + Math.atan2(Math.sinh(eta2), Math.cos(xi2)) * DEG;
  return { lat: lat * DEG, lon };
}

// latitude/longitude -> UTM (WGS84), same series family; inverse of utmToLatLon
const ALPHA = [n / 2 - 2 * n2 / 3 + 5 * n3 / 16 + 41 * n4 / 180, 13 * n2 / 48 - 3 * n3 / 5 + 557 * n4 / 1440, 61 * n3 / 240 - 103 * n4 / 140, 49561 * n4 / 161280];
export function latLonToUtm(lat, lon, zone, hemisphere = 'S') {
  const lon0 = (zone - 1) * 6 - 180 + 3, phi = lat / DEG, dl = (lon - lon0) / DEG;
  const q = 2 * Math.sqrt(n) / (1 + n);
  const t = Math.sinh(Math.atanh(Math.sin(phi)) - q * Math.atanh(q * Math.sin(phi)));
  const xi0 = Math.atan2(t, Math.cos(dl)), eta0 = Math.atanh(Math.sin(dl) / Math.sqrt(1 + t * t));
  let xi = xi0, eta = eta0;
  ALPHA.forEach((a, i) => { const j = 2 * (i + 1); xi += a * Math.sin(j * xi0) * Math.cosh(j * eta0); eta += a * Math.cos(j * xi0) * Math.sinh(j * eta0); });
  return { e: 5e5 + K0 * AA * eta, n: K0 * AA * xi + (hemisphere === 'S' ? 1e7 : 0) };
}
export const zoneOf = lon => Math.min(60, Math.max(1, Math.floor((lon + 180) / 6) + 1));
