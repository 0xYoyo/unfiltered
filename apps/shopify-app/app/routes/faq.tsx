import type { MetaFunction } from "react-router";

import { FaqPage } from "../site/pages/FaqPage";

import "../playground/fonts.css";
import "../playground/tokens.css";
import "../site/site.css";

export const meta: MetaFunction = () => [{ title: "FAQ — Unfiltered" }];

export default function FaqRoute() {
  return <FaqPage />;
}
