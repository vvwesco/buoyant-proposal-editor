import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdfjs canvas rendering doesn't tolerate React's dev-only double-invoke of
  // effects (two render() calls race on the same canvas and deadlock). The
  // components still cancel in-flight render tasks on unmount for production
  // correctness; this just removes the dev-only double fire.
  reactStrictMode: false,
};

export default nextConfig;
