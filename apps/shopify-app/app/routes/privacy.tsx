import type { MetaFunction } from "react-router";

import { PrivacyPage } from "../site/pages/PrivacyPage";

import "../playground/fonts.css";
import "../playground/tokens.css";
import "../site/site.css";

export const meta: MetaFunction = () => [
  { title: "Privacy policy — Unfiltered" },
];

export default function PrivacyRoute() {
  return <PrivacyPage />;
}
