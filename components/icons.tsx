// Inline SVG icons, stroked with currentColor so they take the button's colour.

type P = { size?: number };

const S = ({ size = 13, children, fill }: P & { children: React.ReactNode; fill?: boolean }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill={fill ? "currentColor" : "none"}
    stroke={fill ? "none" : "currentColor"}
    strokeWidth={2.2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
);

export const Plus = (p: P) => <S {...p}><path d="M12 5v14M5 12h14" /></S>;
export const Restart = (p: P) => <S {...p}><path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5" /></S>;
export const Stop = (p: P) => <S {...p} fill><rect x="6" y="6" width="12" height="12" rx="2" /></S>;
export const Play = (p: P) => <S {...p} fill><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" /></S>;
export const Arrow = (p: P) => <S {...p}><path d="M7 17 17 7M8 7h9v9" /></S>;
export const Copy = (p: P) => <S {...p}><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></S>;
export const Check = (p: P) => <S {...p}><path d="m5 12 5 5 9-10" /></S>;
export const Term = (p: P) => <S {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m8 9 3 3-3 3M13 15h4" /></S>;
export const Code = (p: P) => <S {...p}><path d="m8 7-5 5 5 5M16 7l5 5-5 5" /></S>;
export const Folder = (p: P) => <S {...p}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></S>;
export const T3 = (p: P) => <S {...p}><path d="M4 6h16M12 6v13" /></S>;
export const Logs = (p: P) => <S {...p}><path d="M4 6h16M4 12h10M4 18h13" /></S>;
export const Ticket = (p: P) => <S {...p}><path d="M3 8a2 2 0 0 0 0 4v0a2 2 0 0 1 0 4v1a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-1a2 2 0 0 1 0-4 2 2 0 0 0 0-4V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2z" /><path d="M14 5v14" strokeDasharray="2 2.5" /></S>;
export const More = (p: P) => <S {...p} fill><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></S>;
export const Chevron = (p: P) => <S {...p}><path d="m9 6 6 6-6 6" /></S>;
export const Warn = (p: P) => <S {...p}><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /></S>;
export const Shield = (p: P) => <S {...p}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></S>;
export const Trash = (p: P) => <S {...p}><path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3" /></S>;
export const Refresh = (p: P) => <S {...p}><path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5" /></S>;
export const Docs = (p: P) => <S {...p}><path d="M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h5" /></S>;
export const Db = (p: P) => <S {...p}><ellipse cx="12" cy="6" rx="7" ry="3" /><path d="M5 6v12c0 1.7 3 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3 3 7 3s7-1.3 7-3" /></S>;
export const Whale = ({ size = 14 }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M13 7h2v2h-2zM10 7h2v2h-2zM7 7h2v2H7zM10 4h2v2h-2zM4 10h2v2H4zm3 0h2v2H7zm3 0h2v2h-2zm3 0h2v2h-2zm3 0h2v2h-2zM2 13h19.5c.5-1 2-1.5 2.5-1-.5-1.5-2-1.5-2.5-1.2-.3-1.3-1.3-2-1.3-2s-1 1.2-.5 2.6H2.2C2 15 3 21 11 21c6 0 9-3 10.5-8z" />
  </svg>
);

// A branch with three ripening fruit: app, api, db.
export const Logo = ({ size = 26 }: P) => (
  <svg width={size} height={size} viewBox="0 0 26 26" fill="none" aria-hidden="true" className="logo">
    <path d="M6 23V4M6 16c0-4 3-5 7-5h1M6 9c0-3 3-4 6-4h7M6 21c0-2 2-3 5-3h9" stroke="#3b4a5c" strokeWidth="2.2" strokeLinecap="round" />
    <circle cx="20" cy="5" r="3" fill="var(--app)" />
    <circle cx="15" cy="11" r="3" fill="var(--api)" />
    <circle cx="21" cy="18" r="3" fill="var(--db)" />
  </svg>
);
