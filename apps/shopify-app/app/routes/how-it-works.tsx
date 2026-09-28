import type { MetaFunction } from "react-router";

import { HowItWorksPage } from "../site/pages/HowItWorksPage";

import "../playground/fonts.css";
import "../playground/tokens.css";
import "../site/site.css";

export const meta: MetaFunction = () => [
  { title: "How it works — Unfiltered" },
  {
    name: "description",
    content:
      "Short queries never wait for a model. Sentences get read properly. Your shopper never has to know which one they typed.",
  },
];

export default function HowItWorksRoute() {
  return <HowItWorksPage />;
}
