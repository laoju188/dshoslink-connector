/** Exact installed files from the public connector archives. Each alternative must match as a whole. */
const helper012 = {
  "package.json": "edbbcc5e9db13db885f154179447fe863b50909c02dc6a9d04e9a71f1609b9c7",
  "cordis.patch.yml": "651e8bebac518a651547a025f3da5739c5ac641ebb64e5887aa8af1064648c7d",
  "index.js": "494a2b241376b17b74b9a6244fe91f9ec66d1504af5aee431c22076a2641f374",
  "typert.js": "d54fb21a26809c691d1eedb15b8752bc40a30bbb5f5a183fab30ab0c88bf2cb6",
  "client.js": "c4351c7e327d0c23d73f2b7ab6637e5c58c6b1b5d30c0ad27d066997d54bb541",
  "LICENSE": "fac3a4ef4aad6c839fc10a87af87b9e5ae2cac0a6b969f83dbb7203abc4788e4",
  "THIRD_PARTY_NOTICES.md": "b54740c492e0deb9fc141e9a0b9d0afc111e5d6a8fd7e841a767753552593bb5"
}
export const KNOWN_LEGACY_HELPERS: Readonly<Record<string, readonly Readonly<Record<string, string>>[]>> = {
  "0.1.0": [{
    "package.json": "424f36d0e76e44f7c5b3f9e00e4c71274b3b1cf0bbd6f5678b71d5a4982e955c",
    "cordis.patch.yml": "651e8bebac518a651547a025f3da5739c5ac641ebb64e5887aa8af1064648c7d",
    "index.js": "c1acf265c87c97ab75240b3541df29fff1eff7f63696cfa5456fa5ad7f417140",
    "typert.js": "d54fb21a26809c691d1eedb15b8752bc40a30bbb5f5a183fab30ab0c88bf2cb6",
    "client.js": "8d30e419d1f902d92a8648f99cf5592d8012994d5dd8722ab03d76a084c21af4",
    "LICENSE": "fac3a4ef4aad6c839fc10a87af87b9e5ae2cac0a6b969f83dbb7203abc4788e4",
    "THIRD_PARTY_NOTICES.md": "45e604affcc6373b8385c320d35e3ae32df994726611eff8189266f6c08eda8d"
  }],
  "0.1.1": [{
    "package.json": "6db108cf3d2387b778ed9bf4eac9e64f6be81ff9e7596f328d6f802791eff6aa",
    "cordis.patch.yml": "651e8bebac518a651547a025f3da5739c5ac641ebb64e5887aa8af1064648c7d",
    "index.js": "d411e260cee733a9efdb0f31b033fa6b0dd5753c104c560540f0ff39d605b681",
    "typert.js": "d54fb21a26809c691d1eedb15b8752bc40a30bbb5f5a183fab30ab0c88bf2cb6",
    "client.js": "8d30e419d1f902d92a8648f99cf5592d8012994d5dd8722ab03d76a084c21af4",
    "LICENSE": "fac3a4ef4aad6c839fc10a87af87b9e5ae2cac0a6b969f83dbb7203abc4788e4",
    "THIRD_PARTY_NOTICES.md": "b54740c492e0deb9fc141e9a0b9d0afc111e5d6a8fd7e841a767753552593bb5"
  }],
  "0.1.2": [
    helper012, // 0.2.10, 0.2.11 and 0.2.13
    { ...helper012, // 0.2.12
      "typert.js": "90323e35677ba6c9368d0f67f241605aa2a56808c741a3af1b0c5a922ca8aa93",
      "client.js": "018bd1988a3d690eb90620294251c00c772a09cb38d1eeca5cd21bbd769b11e0"
    }
  ]
}
