import type { MetaFunction } from "react-router";

import { TermsPage } from "../site/pages/TermsPage";

import "../playground/fonts.css";
import "../playground/tokens.css";
import "../site/site.css";

export const meta: MetaFunction = () => [
  { title: "Terms of service — Unfiltered" },
];

export default function TermsRoute() {
  return <TermsPage />;
}
