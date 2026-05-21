import mdx from "@astrojs/mdx";
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://k8rvis.github.io",
  base: "/EKS-Maturity-Model",
  integrations: [
    starlight({
      title: "EKS 보안 성숙도 모델",
      description: "EKS 환경을 단계적으로 강화하기 위한 보안 성숙도 모델",
      customCss: ["./src/styles/custom.css"],
      favicon: "/favicon.svg",
      tableOfContents: false,
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/K8RVIS/EKS-Maturity-Model",
        },
      ],
      sidebar: [
        { label: "Introduction", slug: "0-introduction" },
        { label: "Maturity Model", slug: "model" },
        {
          label: "Quick Wins",
          autogenerate: { directory: "quick-wins" },
        },
        {
          label: "Foundational",
          autogenerate: { directory: "foundational" },
        },
        {
          label: "Efficient",
          autogenerate: { directory: "efficient" },
        },
        {
          label: "Optimized",
          autogenerate: { directory: "optimized" },
        },
      ],
    }),
    mdx(),
  ],
});
