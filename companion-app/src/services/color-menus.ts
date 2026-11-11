// Color-space + gamma menu definitions matching Resolve 21's Color Space
// Transform (CST) node. Grouped so the dropdowns can show optgroups instead of
// one flat list of 30+ entries.
//
// Source: Resolve 21 CST node options as of build 21.0 (2026). Updated to
// follow Resolve's grouping conventions and naming exactly so cross-tool color
// management stays consistent.
//
// Reference: TKT-DIST will eventually replace this with an OCIO-config-driven
// list. For now the manual list matches what the colorist sees in Resolve.

export interface OptionGroup {
    label: string;
    options: string[];
}

// Color spaces (gamut + white point). The "Generic" group covers the common
// production gamuts; the others mirror Resolve's CST grouping by family.
export const COLOR_SPACE_GROUPS: OptionGroup[] = [
    {
        label: 'Generic',
        options: [
            'Rec.709',
            'Rec.2020',
            'P3-D60',
            'P3-D65',
            'P3-DCI',
            'sRGB',
            'XYZ',
            'Adobe RGB',
            'CIE-XYZ',
        ],
    },
    {
        label: 'ACES',
        options: [
            'ACES AP0',           // ACES2065-1
            'ACES AP1',           // ACEScg primaries
            'ACEScc AP1',
            'ACEScct AP1',
            'ACEScg AP1',
        ],
    },
    {
        label: 'ARRI',
        options: [
            'ARRI Wide Gamut 3',
            'ARRI Wide Gamut 4',
        ],
    },
    {
        label: 'Canon',
        options: [
            'Canon Cinema Gamut',
            'Canon DCI-P3+',
        ],
    },
    {
        label: 'Sony',
        options: [
            'S-Gamut',
            'S-Gamut3',
            'S-Gamut3.Cine',
        ],
    },
    {
        label: 'Panasonic',
        options: [
            'V-Gamut',
        ],
    },
    {
        label: 'RED',
        options: [
            'REDWideGamutRGB',
            'DRAGONcolor',
            'DRAGONcolor2',
            'REDcolor',
            'REDcolor2',
            'REDcolor3',
            'REDcolor4',
        ],
    },
    {
        label: 'DaVinci',
        options: [
            'DaVinci Wide Gamut',
        ],
    },
    {
        label: 'Blackmagic',
        options: [
            'Blackmagic Design Wide Gamut Gen 4/Gen 5',
        ],
    },
    {
        label: 'NTSC / PAL (legacy)',
        options: [
            'Rec.601 (525)',     // NTSC
            'Rec.601 (625)',     // PAL
            'BT.470 PAL',
            'SMPTE-C',
        ],
    },
];

// Transfer functions / EOTFs. The grouping mirrors Resolve's CST dropdown:
// SDR display curves first, then HDR transfer functions, then log curves
// (alphabetized by camera family).
export const GAMMA_GROUPS: OptionGroup[] = [
    {
        label: 'SDR display',
        options: [
            'BT.1886',
            'sRGB',
            'Gamma 2.2',
            'Gamma 2.4',
            'Gamma 2.6',
            'Linear',
        ],
    },
    {
        label: 'HDR transfer',
        options: [
            'ST.2084 (PQ)',
            'HLG',
            'HDR10',
            'DolbyVision PQ',
        ],
    },
    {
        label: 'ACES',
        options: [
            'ACEScc',
            'ACEScct',
            'ACEScg (linear)',
        ],
    },
    {
        label: 'ARRI',
        options: [
            'Log-C',
            'Log-C v3',
            'Log-C v4',
        ],
    },
    {
        label: 'Canon',
        options: [
            'Canon Log',
            'Canon Log 2',
            'Canon Log 3',
        ],
    },
    {
        label: 'Sony',
        options: [
            'S-Log',
            'S-Log2',
            'S-Log3',
        ],
    },
    {
        label: 'Panasonic',
        options: [
            'V-Log',
        ],
    },
    {
        label: 'RED',
        options: [
            'RED Log Film',
            'REDlogFilm',
            'Log3G10',
            'Log3G12',
        ],
    },
    {
        label: 'DaVinci',
        options: [
            'DaVinci Intermediate',
        ],
    },
    {
        label: 'Blackmagic',
        options: [
            'Blackmagic Design Film Gen 5',
        ],
    },
    {
        label: 'GoPro',
        options: [
            'Protune Flat',
        ],
    },
];

// Flatten helper for cases where we need a single list (e.g. legacy code path
// or autocompletion).
export function flatten(groups: OptionGroup[]): string[] {
    return groups.flatMap(g => g.options);
}
