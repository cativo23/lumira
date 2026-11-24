/** Compare two semver versions. Returns 1 if a > b, -1 if a < b, 0 if equal. */
export function semverCompare(a, b) {
    const parseVer = (v) => {
        const parts = v.replace(/^v/, '').split('.').map(p => parseInt(p, 10));
        return { major: parts[0] ?? 0, minor: parts[1] ?? 0, patch: parts[2] ?? 0 };
    };
    const av = parseVer(a);
    const bv = parseVer(b);
    if (av.major !== bv.major)
        return av.major > bv.major ? 1 : -1;
    if (av.minor !== bv.minor)
        return av.minor > bv.minor ? 1 : -1;
    if (av.patch !== bv.patch)
        return av.patch > bv.patch ? 1 : -1;
    return 0;
}
//# sourceMappingURL=semver.js.map