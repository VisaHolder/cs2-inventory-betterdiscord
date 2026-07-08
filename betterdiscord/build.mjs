import { build } from "esbuild";

const META = `/**
 * @name CS2Inventory
 * @author VisaHolder
 * @description CS2 inventory value on Discord profile popouts — Doppler/Gamma phase pricing (CSFloat), FX-converted prices, and Trade Offer / Steam buttons.
 * @version 1.6.8
 * @source https://github.com/VisaHolder/cs2-inventory-betterdiscord
 * @website https://github.com/VisaHolder/cs2-inventory-betterdiscord
 */
`;

await build({
    entryPoints: ["src/plugin.tsx"],
    bundle: true,
    format: "cjs",
    platform: "browser",
    target: ["chrome120"],
    outfile: "CS2Inventory.plugin.js",
    banner: { js: META },
    legalComments: "none",
    logLevel: "info",
});
console.log("built CS2Inventory.plugin.js");
