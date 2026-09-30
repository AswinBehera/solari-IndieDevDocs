/**
 * A character, drawn: one line weight, a round head, and the thing they carry.
 *
 * Deliberately a doodle rather than an avatar. A face with detail reads as a
 * person, and these are not people; they are browser identities with a
 * neighbourhood and a habit. The prop is the habit, and it is the only part that
 * differs between them, so it is the part a traveller remembers.
 */

const INK = "#23242a"

export function Figure({ prop, size = 120 }: { prop?: string | undefined; size?: number }) {
  return (
    <svg
      viewBox="0 0 120 120"
      width={size}
      height={size}
      fill="none"
      stroke={INK}
      strokeWidth={3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {prop === "headphones" && <path d="M40 44 A20 20 0 0 1 80 44" />}
      <path d="M36 108 Q38 70 60 67 Q82 70 84 108 Z" fill="#fff" />
      <circle cx="60" cy="44" r="17" fill="#fff" />
      <circle cx="54" cy="43" r="1.6" fill={INK} stroke="none" />
      <circle cx="66" cy="43" r="1.6" fill={INK} stroke="none" />
      <path d="M54 50 Q60 55 66 50" />
      {prop === "headphones" && (
        <>
          <rect x="36" y="40" width="7" height="12" rx="3" fill="#fff" />
          <rect x="77" y="40" width="7" height="12" rx="3" fill="#fff" />
        </>
      )}
      <Prop prop={prop} />
    </svg>
  )
}

function Prop({ prop }: { prop?: string | undefined }) {
  switch (prop) {
    case "ladle":
      return (
        <>
          <path d="M80 90 L98 58" />
          <path d="M91 55 Q98 44 106 54 Q102 62 94 60 Z" fill="#fff" />
          <path d="M74 88 Q80 86 82 92" />
        </>
      )
    case "laptop":
      return (
        <>
          <rect x="40" y="80" width="40" height="24" rx="2" fill="#fff" />
          <path d="M34 106 H86" />
          <circle cx="60" cy="92" r="2" fill={INK} stroke="none" />
        </>
      )
    case "camera":
      return (
        <>
          <path d="M46 70 L52 84 M74 70 L68 84" />
          <rect x="46" y="82" width="28" height="18" rx="3" fill="#fff" />
          <circle cx="60" cy="91" r="5.5" fill="#fff" />
          <path d="M66 82 V79 H71 V82" />
        </>
      )
    case "umbrella":
      return (
        <>
          <path d="M92 108 V52" />
          <path d="M72 54 Q92 26 112 54 Q102 49 92 54 Q82 49 72 54 Z" fill="#fff" />
          <path d="M92 108 Q92 112 88 111" />
          <path d="M80 92 Q86 90 92 94" />
        </>
      )
    case "tag":
      return (
        <>
          <path d="M84 70 L100 70 L108 80 L100 90 L84 90 Z" fill="#fff" />
          <circle cx="100" cy="80" r="2" />
          <path d="M88 76 L94 84 M88 84 L88.5 84 M94 76 L94.5 76" />
          <path d="M80 88 Q82 82 86 84" />
        </>
      )
    case "map":
      return (
        <>
          <path d="M40 82 L53 78 L67 82 L80 78 L80 102 L67 106 L53 102 L40 106 Z" fill="#fff" />
          <path d="M53 78 V102 M67 82 V106" />
          <path d="M44 94 Q50 88 56 94 T70 92" strokeDasharray="2 3" />
        </>
      )
    case "headphones":
      return null
    default:
      return <path d="M46 92 Q60 98 74 92" />
  }
}
