import type { MetaFunction } from "react-router";

import { PricingPage } from "../site/pages/PricingPage";

import "../playground/fonts.css";
import "../playground/tokens.css";
import "../site/site.css";

export const meta: MetaFunction = () => [{ title: "Pricing — Unfiltered" }];

export default function PricingRoute() {
  return <PricingPage />;
}
