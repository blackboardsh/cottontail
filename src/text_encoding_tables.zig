const undefined_code_point = 0xffff;

const ibm866: [128]u16 = .{
    1040, 1041, 1042, 1043, 1044, 1045, 1046, 1047, 1048, 1049, 1050, 1051, 1052, 1053, 1054, 1055,
    1056, 1057, 1058, 1059, 1060, 1061, 1062, 1063, 1064, 1065, 1066, 1067, 1068, 1069, 1070, 1071,
    1072, 1073, 1074, 1075, 1076, 1077, 1078, 1079, 1080, 1081, 1082, 1083, 1084, 1085, 1086, 1087,
    9617, 9618, 9619, 9474, 9508, 9569, 9570, 9558, 9557, 9571, 9553, 9559, 9565, 9564, 9563, 9488,
    9492, 9524, 9516, 9500, 9472, 9532, 9566, 9567, 9562, 9556, 9577, 9574, 9568, 9552, 9580, 9575,
    9576, 9572, 9573, 9561, 9560, 9554, 9555, 9579, 9578, 9496, 9484, 9608, 9604, 9612, 9616, 9600,
    1088, 1089, 1090, 1091, 1092, 1093, 1094, 1095, 1096, 1097, 1098, 1099, 1100, 1101, 1102, 1103,
    1025, 1105, 1028, 1108, 1031, 1111, 1038, 1118, 176,  8729, 183,  8730, 8470, 164,  9632, 160,
};

const iso_8859_3: [128]u16 = .{
    128,                  129, 130, 131,                  132, 133,                  134, 135, 136, 137, 138, 139, 140, 141, 142,                  143,
    144,                  145, 146, 147,                  148, 149,                  150, 151, 152, 153, 154, 155, 156, 157, 158,                  159,
    160,                  294, 728, 163,                  164, undefined_code_point, 292, 167, 168, 304, 350, 286, 308, 173, undefined_code_point, 379,
    176,                  295, 178, 179,                  180, 181,                  293, 183, 184, 305, 351, 287, 309, 189, undefined_code_point, 380,
    192,                  193, 194, undefined_code_point, 196, 266,                  264, 199, 200, 201, 202, 203, 204, 205, 206,                  207,
    undefined_code_point, 209, 210, 211,                  212, 288,                  214, 215, 284, 217, 218, 219, 220, 364, 348,                  223,
    224,                  225, 226, undefined_code_point, 228, 267,                  265, 231, 232, 233, 234, 235, 236, 237, 238,                  239,
    undefined_code_point, 241, 242, 243,                  244, 289,                  246, 247, 285, 249, 250, 251, 252, 365, 349,                  729,
};

const iso_8859_6: [128]u16 = .{
    128,                  129,                  130,                  131,                  132,                  133,                  134,                  135,                  136,                  137,                  138,                  139,                  140,                  141,                  142,                  143,
    144,                  145,                  146,                  147,                  148,                  149,                  150,                  151,                  152,                  153,                  154,                  155,                  156,                  157,                  158,                  159,
    160,                  undefined_code_point, undefined_code_point, undefined_code_point, 164,                  undefined_code_point, undefined_code_point, undefined_code_point, undefined_code_point, undefined_code_point, undefined_code_point, undefined_code_point, 1548,                 173,                  undefined_code_point, undefined_code_point,
    undefined_code_point, undefined_code_point, undefined_code_point, undefined_code_point, undefined_code_point, undefined_code_point, undefined_code_point, undefined_code_point, undefined_code_point, undefined_code_point, undefined_code_point, 1563,                 undefined_code_point, undefined_code_point, undefined_code_point, 1567,
    undefined_code_point, 1569,                 1570,                 1571,                 1572,                 1573,                 1574,                 1575,                 1576,                 1577,                 1578,                 1579,                 1580,                 1581,                 1582,                 1583,
    1584,                 1585,                 1586,                 1587,                 1588,                 1589,                 1590,                 1591,                 1592,                 1593,                 1594,                 undefined_code_point, undefined_code_point, undefined_code_point, undefined_code_point, undefined_code_point,
    1600,                 1601,                 1602,                 1603,                 1604,                 1605,                 1606,                 1607,                 1608,                 1609,                 1610,                 1611,                 1612,                 1613,                 1614,                 1615,
    1616,                 1617,                 1618,                 undefined_code_point, undefined_code_point, undefined_code_point, undefined_code_point, undefined_code_point, undefined_code_point, undefined_code_point, undefined_code_point, undefined_code_point, undefined_code_point, undefined_code_point, undefined_code_point, undefined_code_point,
};

const iso_8859_7: [128]u16 = .{
    128, 129,  130,                  131, 132,  133,  134, 135, 136, 137, 138, 139, 140, 141, 142,                  143,
    144, 145,  146,                  147, 148,  149,  150, 151, 152, 153, 154, 155, 156, 157, 158,                  159,
    160, 8216, 8217,                 163, 8364, 8367, 166, 167, 168, 169, 890, 171, 172, 173, undefined_code_point, 8213,
    176, 177,  178,                  179, 900,  901,  902, 183, 904, 905, 906, 187, 908, 189, 910,                  911,
    912, 913,  914,                  915, 916,  917,  918, 919, 920, 921, 922, 923, 924, 925, 926,                  927,
    928, 929,  undefined_code_point, 931, 932,  933,  934, 935, 936, 937, 938, 939, 940, 941, 942,                  943,
    944, 945,  946,                  947, 948,  949,  950, 951, 952, 953, 954, 955, 956, 957, 958,                  959,
    960, 961,  962,                  963, 964,  965,  966, 967, 968, 969, 970, 971, 972, 973, 974,                  undefined_code_point,
};

const iso_8859_8: [128]u16 = .{
    128,                  129,                  130,                  131,                  132,                  133,                  134,                  135,                  136,                  137,                  138,                  139,                  140,                  141,                  142,                  143,
    144,                  145,                  146,                  147,                  148,                  149,                  150,                  151,                  152,                  153,                  154,                  155,                  156,                  157,                  158,                  159,
    160,                  undefined_code_point, 162,                  163,                  164,                  165,                  166,                  167,                  168,                  169,                  215,                  171,                  172,                  173,                  174,                  175,
    176,                  177,                  178,                  179,                  180,                  181,                  182,                  183,                  184,                  185,                  247,                  187,                  188,                  189,                  190,                  undefined_code_point,
    undefined_code_point, undefined_code_point, undefined_code_point, undefined_code_point, undefined_code_point, undefined_code_point, undefined_code_point, undefined_code_point, undefined_code_point, undefined_code_point, undefined_code_point, undefined_code_point, undefined_code_point, undefined_code_point, undefined_code_point, undefined_code_point,
    undefined_code_point, undefined_code_point, undefined_code_point, undefined_code_point, undefined_code_point, undefined_code_point, undefined_code_point, undefined_code_point, undefined_code_point, undefined_code_point, undefined_code_point, undefined_code_point, undefined_code_point, undefined_code_point, undefined_code_point, 8215,
    1488,                 1489,                 1490,                 1491,                 1492,                 1493,                 1494,                 1495,                 1496,                 1497,                 1498,                 1499,                 1500,                 1501,                 1502,                 1503,
    1504,                 1505,                 1506,                 1507,                 1508,                 1509,                 1510,                 1511,                 1512,                 1513,                 1514,                 undefined_code_point, undefined_code_point, 8206,                 8207,                 undefined_code_point,
};

const koi8_u: [128]u16 = .{
    9472, 9474, 9484, 9488, 9492, 9496, 9500, 9508, 9516, 9524, 9532, 9600, 9604, 9608, 9612, 9616,
    9617, 9618, 9619, 8992, 9632, 8729, 8730, 8776, 8804, 8805, 160,  8993, 176,  178,  183,  247,
    9552, 9553, 9554, 1105, 1108, 9556, 1110, 1111, 9559, 9560, 9561, 9562, 9563, 1169, 1118, 9566,
    9567, 9568, 9569, 1025, 1028, 9571, 1030, 1031, 9574, 9575, 9576, 9577, 9578, 1168, 1038, 169,
    1102, 1072, 1073, 1094, 1076, 1077, 1092, 1075, 1093, 1080, 1081, 1082, 1083, 1084, 1085, 1086,
    1087, 1103, 1088, 1089, 1090, 1091, 1078, 1074, 1100, 1099, 1079, 1096, 1101, 1097, 1095, 1098,
    1070, 1040, 1041, 1062, 1044, 1045, 1060, 1043, 1061, 1048, 1049, 1050, 1051, 1052, 1053, 1054,
    1055, 1071, 1056, 1057, 1058, 1059, 1046, 1042, 1068, 1067, 1047, 1064, 1069, 1065, 1063, 1066,
};

const windows_874: [128]u16 = .{
    8364, 129,  130,  131,  132,  8230, 134,  135,  136,  137,  138,  139,                  140,                  141,                  142,                  143,
    144,  8216, 8217, 8220, 8221, 8226, 8211, 8212, 152,  153,  154,  155,                  156,                  157,                  158,                  159,
    160,  3585, 3586, 3587, 3588, 3589, 3590, 3591, 3592, 3593, 3594, 3595,                 3596,                 3597,                 3598,                 3599,
    3600, 3601, 3602, 3603, 3604, 3605, 3606, 3607, 3608, 3609, 3610, 3611,                 3612,                 3613,                 3614,                 3615,
    3616, 3617, 3618, 3619, 3620, 3621, 3622, 3623, 3624, 3625, 3626, 3627,                 3628,                 3629,                 3630,                 3631,
    3632, 3633, 3634, 3635, 3636, 3637, 3638, 3639, 3640, 3641, 3642, undefined_code_point, undefined_code_point, undefined_code_point, undefined_code_point, 3647,
    3648, 3649, 3650, 3651, 3652, 3653, 3654, 3655, 3656, 3657, 3658, 3659,                 3660,                 3661,                 3662,                 3663,
    3664, 3665, 3666, 3667, 3668, 3669, 3670, 3671, 3672, 3673, 3674, 3675,                 undefined_code_point, undefined_code_point, undefined_code_point, undefined_code_point,
};

const windows_1252: [128]u16 = .{
    8364, 129,  8218, 402,  8222, 8230, 8224, 8225, 710, 8240, 352, 8249, 338, 141, 381, 143,
    144,  8216, 8217, 8220, 8221, 8226, 8211, 8212, 732, 8482, 353, 8250, 339, 157, 382, 376,
    160,  161,  162,  163,  164,  165,  166,  167,  168, 169,  170, 171,  172, 173, 174, 175,
    176,  177,  178,  179,  180,  181,  182,  183,  184, 185,  186, 187,  188, 189, 190, 191,
    192,  193,  194,  195,  196,  197,  198,  199,  200, 201,  202, 203,  204, 205, 206, 207,
    208,  209,  210,  211,  212,  213,  214,  215,  216, 217,  218, 219,  220, 221, 222, 223,
    224,  225,  226,  227,  228,  229,  230,  231,  232, 233,  234, 235,  236, 237, 238, 239,
    240,  241,  242,  243,  244,  245,  246,  247,  248, 249,  250, 251,  252, 253, 254, 255,
};

const windows_1253: [128]u16 = .{
    8364, 129,  8218,                 402,  8222, 8230, 8224, 8225, 136, 8240, 138,                  8249, 140, 141, 142, 143,
    144,  8216, 8217,                 8220, 8221, 8226, 8211, 8212, 152, 8482, 154,                  8250, 156, 157, 158, 159,
    160,  901,  902,                  163,  164,  165,  166,  167,  168, 169,  undefined_code_point, 171,  172, 173, 174, 8213,
    176,  177,  178,                  179,  900,  181,  182,  183,  904, 905,  906,                  187,  908, 189, 910, 911,
    912,  913,  914,                  915,  916,  917,  918,  919,  920, 921,  922,                  923,  924, 925, 926, 927,
    928,  929,  undefined_code_point, 931,  932,  933,  934,  935,  936, 937,  938,                  939,  940, 941, 942, 943,
    944,  945,  946,                  947,  948,  949,  950,  951,  952, 953,  954,                  955,  956, 957, 958, 959,
    960,  961,  962,                  963,  964,  965,  966,  967,  968, 969,  970,                  971,  972, 973, 974, undefined_code_point,
};

const windows_1255: [128]u16 = .{
    8364, 129,  8218, 402,  8222, 8230, 8224, 8225, 710,  8240,                 138,                  8249,                 140,                  141,                  142,                  143,
    144,  8216, 8217, 8220, 8221, 8226, 8211, 8212, 732,  8482,                 154,                  8250,                 156,                  157,                  158,                  159,
    160,  161,  162,  163,  8362, 165,  166,  167,  168,  169,                  215,                  171,                  172,                  173,                  174,                  175,
    176,  177,  178,  179,  180,  181,  182,  183,  184,  185,                  247,                  187,                  188,                  189,                  190,                  191,
    1456, 1457, 1458, 1459, 1460, 1461, 1462, 1463, 1464, 1465,                 1466,                 1467,                 1468,                 1469,                 1470,                 1471,
    1472, 1473, 1474, 1475, 1520, 1521, 1522, 1523, 1524, undefined_code_point, undefined_code_point, undefined_code_point, undefined_code_point, undefined_code_point, undefined_code_point, undefined_code_point,
    1488, 1489, 1490, 1491, 1492, 1493, 1494, 1495, 1496, 1497,                 1498,                 1499,                 1500,                 1501,                 1502,                 1503,
    1504, 1505, 1506, 1507, 1508, 1509, 1510, 1511, 1512, 1513,                 1514,                 undefined_code_point, undefined_code_point, 8206,                 8207,                 undefined_code_point,
};

const windows_1257: [128]u16 = .{
    8364, 129,                  8218, 131,  8222, 8230,                 8224, 8225, 136, 8240, 138, 8249, 140, 168, 711, 184,
    144,  8216,                 8217, 8220, 8221, 8226,                 8211, 8212, 152, 8482, 154, 8250, 156, 175, 731, 159,
    160,  undefined_code_point, 162,  163,  164,  undefined_code_point, 166,  167,  216, 169,  342, 171,  172, 173, 174, 198,
    176,  177,                  178,  179,  180,  181,                  182,  183,  248, 185,  343, 187,  188, 189, 190, 230,
    260,  302,                  256,  262,  196,  197,                  280,  274,  268, 201,  377, 278,  290, 310, 298, 315,
    352,  323,                  325,  211,  332,  213,                  214,  215,  370, 321,  346, 362,  220, 379, 381, 223,
    261,  303,                  257,  263,  228,  229,                  281,  275,  269, 233,  378, 279,  291, 311, 299, 316,
    353,  324,                  326,  243,  333,  245,                  246,  247,  371, 322,  347, 363,  252, 380, 382, 729,
};

pub const Result = enum(c_int) {
    unsupported = 0,
    success = 1,
    invalid = 2,
};

fn tableFor(encoding: u8) ?*const [128]u16 {
    return switch (encoding) {
        1 => &ibm866,
        3 => &iso_8859_3,
        6 => &iso_8859_6,
        7 => &iso_8859_7,
        8, 9 => &iso_8859_8,
        16 => &koi8_u,
        18 => &windows_874,
        21 => &windows_1252,
        22 => &windows_1253,
        24 => &windows_1255,
        26 => &windows_1257,
        else => null,
    };
}

pub fn decode(
    encoding: u8,
    input: []const u8,
    output: []u16,
    fatal: bool,
) Result {
    const table = tableFor(encoding) orelse return .unsupported;
    if (output.len < input.len) return .unsupported;
    for (input, output[0..input.len]) |byte, *code_unit| {
        if (byte < 0x80) {
            code_unit.* = byte;
            continue;
        }
        const mapped = table[byte - 0x80];
        if (undefined_code_point == mapped) {
            if (fatal) return .invalid;
            code_unit.* = 0xfffd;
        } else {
            code_unit.* = mapped;
        }
    }
    return .success;
}

test "undefined pointers replace or fail" {
    const input = [_]u8{ 0x41, 0xa5, 0x42 };
    var output: [input.len]u16 = undefined;
    try @import("std").testing.expectEqual(Result.success, decode(3, &input, &output, false));
    try @import("std").testing.expectEqualSlices(u16, &.{ 0x41, 0xfffd, 0x42 }, &output);
    try @import("std").testing.expectEqual(Result.invalid, decode(3, &input, &output, true));
}
