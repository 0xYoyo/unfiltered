import type { MetaFunction } from "react-router";

import { PricingPage } from "../site/pages/PricingPage";

import "../playground/fonts.css";
import "../playground/tokens.css";
import "../site/site.css";

export const meta: MetaFunction = () => [
  { title: "Pricing — Unfiltered" },
  {
    name: "description",
    content:
      "Every plan includes attribution reporting, the classic-search fallback, and a 14-day trial.",
  },
];

export default function PricingRoute() {
  return <PricingPage />;
}
