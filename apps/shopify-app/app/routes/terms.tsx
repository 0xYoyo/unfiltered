import type { MetaFunction } from "react-router";

import { TermsPage } from "../site/pages/TermsPage";

import "../playground/fonts.css";
import "../playground/tokens.css";
import "../site/site.css";

export const meta: MetaFunction = () => [
  { title: "Terms of service — Unfiltered" },
  {
    name: "description",
    content:
      "A structural draft of the agreement between Unfiltered and a merchant installing the app. Not reviewed by counsel, not in force.",
  },
];

export default function TermsRoute() {
  return <TermsPage />;
}
