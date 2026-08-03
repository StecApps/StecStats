/**
 * Design tokens derived from the web app's index.css (dark theme primary).
 * HSL values converted to hex to match the hoops-stats web artifact exactly.
 */
const colors = {
  light: {
    background: '#FAFAFA',
    foreground: '#0C0A09',
    card: '#FFFFFF',
    cardForeground: '#0C0A09',
    border: '#E8E4E1',
    primary: '#FF531A',
    primaryForeground: '#FFFFFF',
    secondary: '#F0EDEA',
    secondaryForeground: '#0C0A09',
    muted: '#E8E4E1',
    mutedForeground: '#7A7370',
    accent: '#F0EDEA',
    accentForeground: '#0C0A09',
    destructive: '#EF4343',
    destructiveForeground: '#FFFFFF',
    input: '#DAD6D3',
    ring: '#FF531A',
    // Legacy aliases
    text: '#0C0A09',
    tint: '#FF531A',
  },
  dark: {
    background: '#0C0A09',
    foreground: '#FAFAFA',
    card: '#141110',
    cardForeground: '#FAFAFA',
    border: '#2C2826',
    primary: '#FF531A',
    primaryForeground: '#FFFFFF',
    secondary: '#261E1A',
    secondaryForeground: '#FAFAFA',
    muted: '#211C18',
    mutedForeground: '#B7B2AE',
    accent: '#261E1A',
    accentForeground: '#FAFAFA',
    destructive: '#EF4343',
    destructiveForeground: '#FFFFFF',
    input: '#413C39',
    ring: '#FF531A',
    // Legacy aliases
    text: '#FAFAFA',
    tint: '#FF531A',
  },
  radius: 4,
};

export default colors;
