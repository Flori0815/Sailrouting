// Dehler 37 CR polar performance matrix (boat speed through water, in knots)
export const POLAR_TWS = [6, 8, 10, 12, 14, 16, 20, 25];

export const POLAR_TWA = [35, 40, 45, 52, 60, 75, 90, 110, 120, 135, 150, 165, 180];

export const DEHLER37_POLAR = [
  [3.12, 4.31, 5.12, 5.64, 5.92, 6.10, 6.22, 6.05], // 35°
  [3.65, 4.95, 5.75, 6.25, 6.51, 6.68, 6.78, 6.62], // 40°
  [4.10, 5.48, 6.22, 6.65, 6.89, 7.02, 7.14, 7.01], // 45°
  [4.55, 5.92, 6.61, 7.01, 7.23, 7.35, 7.48, 7.38], // 52°
  [4.92, 6.25, 6.88, 7.24, 7.46, 7.60, 7.75, 7.68], // 60°
  [5.25, 6.55, 7.15, 7.48, 7.72, 7.90, 8.12, 8.10], // 75°
  [5.38, 6.70, 7.30, 7.64, 7.92, 8.15, 8.42, 8.45], // 90°
  [5.20, 6.62, 7.28, 7.68, 8.01, 8.28, 8.65, 8.78], // 110°
  [4.85, 6.35, 7.10, 7.55, 7.92, 8.25, 8.72, 8.92], // 120°
  [4.15, 5.60, 6.55, 7.20, 7.65, 8.05, 8.68, 9.15], // 135°
  [3.42, 4.68, 5.72, 6.52, 7.12, 7.60, 8.35, 8.95], // 150°
  [2.95, 4.05, 5.02, 5.85, 6.50, 7.05, 7.85, 8.52], // 165°
  [2.65, 3.65, 4.55, 5.35, 6.02, 6.55, 7.40, 8.10]  // 180°
];

// Boat cannot point higher than this true wind angle
export const NO_GO_ANGLE_DEG = 34;

export const DEFAULT_MAP_CENTER = [54.02, 8.25];
export const DEFAULT_MAP_ZOOM = 10;

export const PRESETS = {
  helgoland: {
    label: 'Cuxhaven → Helgoland',
    view: { center: [54.02, 8.25], zoom: 10 },
    waypoints: [
      { lat: 53.8850, lng: 8.6850, name: 'Cuxhaven Kugelbake' },
      { lat: 53.9850, lng: 8.3500, name: 'Elbe 1 Feuerschiff' },
      { lat: 54.1750, lng: 7.8920, name: 'Helgoland Südhafen' }
    ],
    avoidZones: [
      {
        name: 'Scharhörn Riff (Watt)',
        points: [
          [53.9200, 8.4200],
          [53.9700, 8.3500],
          [53.9600, 8.5200],
          [53.9100, 8.5500]
        ]
      },
      {
        name: 'Mellum & Hohe Weg Watt',
        points: [
          [53.7500, 8.1500],
          [53.8800, 8.2200],
          [53.8300, 8.3500],
          [53.7200, 8.2800]
        ]
      }
    ]
  },
  kiel: {
    label: 'Kiel → Marstal (Ostsee)',
    view: { center: [54.60, 10.35], zoom: 10 },
    waypoints: [
      { lat: 54.4250, lng: 10.1850, name: 'Kiel-Schilksee' },
      { lat: 54.5100, lng: 10.2700, name: 'Kiel Leuchtturm' },
      { lat: 54.8500, lng: 10.5100, name: 'Marstal Port' }
    ],
    avoidZones: [
      {
        name: 'Langeland Flach',
        points: [
          [54.7400, 10.6000],
          [54.8000, 10.6800],
          [54.7500, 10.7500],
          [54.7000, 10.6500]
        ]
      }
    ]
  },
  solent: {
    label: 'Solent Round Island',
    view: { center: [50.74, -1.35], zoom: 11 },
    waypoints: [
      { lat: 50.7630, lng: -1.2980, name: 'Cowes' },
      { lat: 50.7300, lng: -1.4100, name: 'Newtown Bay' },
      { lat: 50.7070, lng: -1.5000, name: 'Yarmouth' }
    ],
    avoidZones: []
  },
  sfbay: {
    label: 'San Francisco Bay',
    view: { center: [37.82, -122.42], zoom: 12 },
    waypoints: [
      { lat: 37.8080, lng: -122.4100, name: "Fisherman's Wharf" },
      { lat: 37.8190, lng: -122.4780, name: 'Golden Gate Bridge' },
      { lat: 37.8600, lng: -122.4300, name: 'Sausalito Pt' }
    ],
    avoidZones: []
  }
};
