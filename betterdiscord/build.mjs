import { build } from "esbuild";

const META = `/**
 * @name SteamInventoryValue
 * @author VisaHolder
 * @description CS2 inventory value on Discord profile popouts — Doppler/Gamma phase pricing (CSFloat), FX-converted prices, and Trade Offer / Steam buttons.
 * @version 1.5.2
 * @source https://github.com/VisaHolder/steam-inventory-value
 * @website https://github.com/VisaHolder/steam-inventory-value
 */
`;

await build({
    entryPoints: ["src/plugin.tsx"],
    bundle: true,
    format: "cjs",
    platform: "browser",
    target: ["chrome120"],
    outfile: "SteamInventoryValue.plugin.js",
    banner: { js: META },
    legalComments: "none",
    logLevel: "info",
});
console.log("built SteamInventoryValue.plugin.js");
