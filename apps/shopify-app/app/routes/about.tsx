import type { MetaFunction } from "react-router";

import { AboutPage } from "../site/pages/AboutPage";

import "../playground/fonts.css";
import "../playground/tokens.css";
import "../site/site.css";

export const meta: MetaFunction = () => [{ title: "About — Unfiltered" }];

export default function AboutRoute() {
  return <AboutPage />;
}
