import type { Metadata, Viewport } from "next";
import { Inter, Bricolage_Grotesque } from "next/font/google";
import { appUrl } from "@/lib/env";
import { VENTURE_BRAND } from "@/modules/workspaces/brand";
import { StaleDeploymentBanner } from "@/components/stale-deployment-banner";
import "./globals.css";

// Inter — UI text. Bricolage Grotesque — display/numerals (used lowercase).
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const bricolage = Bricolage_Grotesque({
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
});

const TITLE = "Venture OS";
const DESCRIPTION = "AI-assisted sales & delivery workspace";

/**
 * A FUNCTION, not a static `metadata` object, for one reason: `metadataBase`.
 *
 * og:image has to be an absolute URL — a crawler has no page to resolve a
 * relative one against — and Next builds it by resolving the relative path
 * against `metadataBase`. A static export is evaluated at BUILD time, which
 * would bake whatever APP_URL the image was built with into every deployment's
 * link previews; the container is built once and run with a runtime env, so that
 * is exactly the wrong moment to read it. Same reasoning as the manifest route.
 */
export function generateMetadata(): Metadata {
  return {
    metadataBase: new URL(appUrl()),
    title: TITLE,
    description: DESCRIPTION,
    manifest: "/manifest.webmanifest",
    appleWebApp: { capable: true, title: TITLE, statusBarStyle: "black-translucent" },
    icons: {
      // SVG first for browsers that take it (crisp at every size); the .ico is the
      // fallback and carries 16 / 32 / 48px rasters, the 16 drawn a little tighter
      // so the mark still reads at tab size.
      icon: [
        { url: "/favicon.svg", type: "image/svg+xml" },
        { url: "/favicon.ico", sizes: "16x16 32x32 48x48" },
      ],
      apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
      // Safari's pinned tab. It ignores everything above and wants one opaque
      // colour on transparent, which it then recolours itself — so `color` is the
      // tint it applies, not a colour baked into the file.
      other: [{ rel: "mask-icon", url: "/mask-icon.svg", color: VENTURE_BRAND.color }],
    },
    openGraph: {
      type: "website",
      siteName: TITLE,
      title: TITLE,
      description: DESCRIPTION,
      images: [{ url: "/og-image.png", width: 1200, height: 630, alt: TITLE }],
    },
    twitter: { card: "summary_large_image", images: ["/og-image.png"] },
  };
}

export const viewport: Viewport = {
  // The seed brand's canvas, not a literal — it is the same colour the icon
  // plates and the manifest splash are generated against, and they must not be
  // able to drift apart.
  themeColor: VENTURE_BRAND.canvas,
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${inter.variable} ${bricolage.variable}`}>
      <body className="min-h-screen bg-canvas font-sans text-ink antialiased">
        {children}
        <StaleDeploymentBanner />
      </body>
    </html>
  );
}
