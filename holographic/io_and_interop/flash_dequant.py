"""DeepSeek-V4-Flash official-style dequant (UE8M0 scales, E4M3, packed FP4)."""
import numpy as np

FP4_TABLE = np.array([
    0.0, 0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0,
    0.0, -0.5, -1.0, -1.5, -2.0, -3.0, -4.0, -6.0,
], dtype=np.float32)


def dequant_fp8_block128(weight_f32, scale_f32):
    M, K = weight_f32.shape
    bm = bk = 128
    S = np.asarray(scale_f32, np.float32)
    W = np.asarray(weight_f32, np.float32)
    return (W.reshape(M // bm, bm, K // bk, bk) * S[:, None, :, None]).reshape(M, K)


def dequant_fp4_packed(weight_i8, scale_f32):
    out_dim, packed = weight_i8.shape
    in_dim = packed * 2
    u = weight_i8.astype(np.uint8, copy=False)
    low, high = u & 0x0F, u >> 4
    x = np.stack([FP4_TABLE[low], FP4_TABLE[high]], axis=-1).reshape(out_dim, in_dim)
    S = np.asarray(scale_f32, np.float32)
    assert S.shape == (out_dim, in_dim // 32), (S.shape, out_dim, in_dim)
    return (x.reshape(out_dim, -1, 32) * S[..., None]).reshape(out_dim, in_dim)


def dequant_pair(weights, name):
    if not name.endswith(".weight"):
        raise KeyError(name)
    sname = name[:-7] + ".scale"
    w = weights[name]
    scale = weights[sname]
    if np.asarray(w).dtype == np.int8:
        return dequant_fp4_packed(np.asarray(w), scale)
    return dequant_fp8_block128(np.asarray(w, np.float32), scale)
