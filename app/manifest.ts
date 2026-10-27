import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Grubbs Worktrees",
    short_name: "Worktrees",
    description: "Grubbs ticket worktrees: launch, ports, start and stop, logs",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#090d12",
    theme_color: "#090d12",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
    ],
  };
}
