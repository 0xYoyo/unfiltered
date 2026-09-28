import type { MetaFunction } from "react-router";

import { PrivacyPage } from "../site/pages/PrivacyPage";

import "../playground/fonts.css";
import "../playground/tokens.css";
import "../site/site.css";

export const meta: MetaFunction = () => [
  { title: "Privacy policy — Unfiltered" },
  {
    name: "description",
    content:
      "This is a structural draft covering what a Shopify app of this kind must disclose. It has not been reviewed by counsel and is not yet binding on anyone.",
  },
];

export default function PrivacyRoute() {
  return <PrivacyPage />;
}
