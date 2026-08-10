// Address lookup and phone formatting.
//
// Two lookup providers, tried in order:
//   1. Google Places — real type-ahead, needs GOOGLE_MAPS_API_KEY and billing enabled.
//   2. US Census geocoder — free, no key, no signup, US-only. Not type-ahead: it
//      matches a full-ish address and hands back the standardised version.
// Either way, typing is never blocked — if both fail you just fill the fields yourself.

const GOOGLE_KEY = () => process.env.GOOGLE_MAPS_API_KEY || '';
const googleEnabled = () => !!GOOGLE_KEY();

// ---------- Google Places ----------
async function googleSuggest(query) {
  const url = 'https://places.googleapis.com/v1/places:autocomplete';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': GOOGLE_KEY(),
      'X-Goog-FieldMask': 'suggestions.placePrediction.placeId,suggestions.placePrediction.text',
    },
    body: JSON.stringify({
      input: query,
      includedRegionCodes: ['us'],
      includedPrimaryTypes: ['street_address', 'premise', 'subpremise'],
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ? json.error.message : `Places error ${res.status}`);
  return (json.suggestions || []).map(s => ({
    id: s.placePrediction.placeId,
    label: s.placePrediction.text.text,
    provider: 'google',
  }));
}

async function googleDetails(placeId) {
  const res = await fetch(`https://places.googleapis.com/v1/places/${placeId}`, {
    headers: {
      'X-Goog-Api-Key': GOOGLE_KEY(),
      'X-Goog-FieldMask': 'addressComponents,formattedAddress,location',
    },
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ? json.error.message : `Places error ${res.status}`);
  const pick = (type, short) => {
    const c = (json.addressComponents || []).find(x => (x.types || []).includes(type));
    return c ? (short ? c.shortText : c.longText) : '';
  };
  const streetNumber = pick('street_number');
  const route = pick('route');
  return {
    address: [streetNumber, route].filter(Boolean).join(' ') || json.formattedAddress || '',
    city: pick('locality') || pick('sublocality') || pick('administrative_area_level_3'),
    state: pick('administrative_area_level_1', true),
    zip: pick('postal_code'),
    county: pick('administrative_area_level_2'),
    lat: json.location ? json.location.latitude : null,
    lng: json.location ? json.location.longitude : null,
    formatted: json.formattedAddress || '',
  };
}

// ---------- US Census geocoder (free, no key) ----------
async function censusLookup(query) {
  const url = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress'
    + `?address=${encodeURIComponent(query)}&benchmark=Public_AR_Current&format=json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Census lookup failed (${res.status})`);
  const json = await res.json();
  const matches = (json.result && json.result.addressMatches) || [];
  return matches.slice(0, 5).map((m, i) => {
    const c = m.addressComponents || {};
    const street = [c.preQualifier, c.preDirection, c.preType, c.streetName, c.suffixType,
      c.suffixDirection, c.suffixQualifier].filter(Boolean).join(' ');
    return {
      id: 'census-' + i,
      label: m.matchedAddress,
      provider: 'census',
      details: {
        address: [c.fromAddress, street].filter(Boolean).join(' ').trim() || m.matchedAddress.split(',')[0],
        city: c.city || '', state: c.state || '', zip: c.zip || '',
        lat: m.coordinates ? m.coordinates.y : null,
        lng: m.coordinates ? m.coordinates.x : null,
        formatted: m.matchedAddress,
      },
    };
  });
}

async function suggest(query) {
  if (!query || query.trim().length < 4) return { provider: null, suggestions: [] };
  if (googleEnabled()) {
    try { return { provider: 'google', suggestions: await googleSuggest(query) }; }
    catch (e) { /* fall through to the free provider */ }
  }
  try { return { provider: 'census', suggestions: await censusLookup(query) }; }
  catch (e) { return { provider: null, suggestions: [], error: e.message }; }
}

async function details(id, provider) {
  if (provider === 'google') return googleDetails(id);
  return null;   // census suggestions already carry their details
}

// ---------- phone formatting ----------
// Stored and displayed the same way everywhere: 555-555-5555, with the country code
// or extension kept when present. Anything unrecognisable is left exactly as typed.
function formatPhone(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  const ext = (s.match(/(?:ext|x|extension)\.?\s*(\d+)\s*$/i) || [])[1];
  const digits = s.replace(/\D/g, '').replace(new RegExp(ext + '$'), ext ? '' : '$&');
  let core = ext ? digits.slice(0, digits.length - ext.length) : digits;
  let country = '';
  if (core.length === 11 && core[0] === '1') { country = '1-'; core = core.slice(1); }
  else if (core.length > 11) return s;
  if (core.length !== 10) return s;
  const out = `${country}${core.slice(0, 3)}-${core.slice(3, 6)}-${core.slice(6)}`;
  return ext ? `${out} x${ext}` : out;
}

module.exports = { suggest, details, googleEnabled, formatPhone };
