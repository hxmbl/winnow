/** The demo's brand logos as a `LogoSource`: bundled images, no network. */

import { DEMO_BRAND_LOGOS } from "../core/data/demo";
import { staticLogoSource } from "./senderPictures";

export const DEMO_LOGO_SOURCE = staticLogoSource(DEMO_BRAND_LOGOS);
