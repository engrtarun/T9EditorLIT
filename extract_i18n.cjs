const fs = require("fs");
const path = "C:/Users/pocot/Music/T9EditorLIT/Clipchamp_Bunny/src/lib/stores/i18n.svelte.ts";
const content = fs.readFileSync(path, "utf8");

// Extract en dictionary
const enMatch = content.match(/const en: Dict = \{([\s\S]*?)\n\};/);
if (enMatch) {
  const enSection = enMatch[1];
  const enDict = {};
  const regex = /'([^']+)'\s*:\s*'([^']+)'/g;
  let match;
  while ((match = regex.exec(enSection)) !== null) {
    enDict[match[1]] = match[2];
  }
  fs.writeFileSync(
    "C:/Users/pocot/Music/T9EditorLIT/Clipchamp_Bunny/src/lib/i18n/locales/en.json",
    JSON.stringify(enDict, null, 2),
  );
  console.log("en.json written with", Object.keys(enDict).length, "keys");
}

// Extract hinglish dictionary
const hiMatch = content.match(/const hinglish: Dict = \{([\s\S]*?)\n\};/);
if (hiMatch) {
  const hiSection = hiMatch[1];
  const hiDict = {};
  const regex = /'([^']+)'\s*:\s*'([^']+)'/g;
  let match;
  while ((match = regex.exec(hiSection)) !== null) {
    hiDict[match[1]] = match[2];
  }
  fs.writeFileSync(
    "C:/Users/pocot/Music/T9EditorLIT/Clipchamp_Bunny/src/lib/i18n/locales/hinglish.json",
    JSON.stringify(hiDict, null, 2),
  );
  console.log("hinglish.json written with", Object.keys(hiDict).length, "keys");
}

// Extract hi dictionary
const hMatch = content.match(/const hi: Dict = \{([\s\S]*?)\n\};/);
if (hMatch) {
  const hSection = hMatch[1];
  const hDict = {};
  const regex = /'([^']+)'\s*:\s*'([^']+)'/g;
  let match;
  while ((match = regex.exec(hSection)) !== null) {
    hDict[match[1]] = match[2];
  }
  fs.writeFileSync(
    "C:/Users/pocot/Music/T9EditorLIT/Clipchamp_Bunny/src/lib/i18n/locales/hi.json",
    JSON.stringify(hDict, null, 2),
  );
  console.log("hi.json written with", Object.keys(hDict).length, "keys");
}
