import type { MetaFunction } from "react-router";

import { HowItWorksPage } from "../site/pages/HowItWorksPage";

import "../playground/fonts.css";
import "../playground/tokens.css";
import "../site/site.css";

export const meta: MetaFunction = () => [
  { title: "How it works — Unfiltered" },
];

export default function HowItWorksRoute() {
  return <HowItWorksPage />;
}
