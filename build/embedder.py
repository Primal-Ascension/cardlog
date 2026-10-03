"""Art-box crop, preprocessing and ONNX embedding, shared by the catalog build
and the photo evaluation. Phase 3's browser code must reproduce preprocess()
exactly; its parameters are published in manifest.json."""
import numpy as np
from PIL import Image

from config import ENCODER, MODEL_DIR


def art_crop(card_img):
    w, h = card_img.size
    l, t, r, b = ENCODER['art_box']
    return card_img.crop((round(l * w), round(t * h), round(r * w), round(b * h)))


def preprocess(imgs):
    """PIL images -> float32 [N,3,S,S]: squash to SxS (bilinear), scale to 0-1, normalize."""
    s = ENCODER['input_size']
    mean = np.array(ENCODER['mean'], np.float32)
    std = np.array(ENCODER['std'], np.float32)
    arr = np.stack([np.asarray(i.convert('RGB').resize((s, s), Image.BILINEAR), np.float32) / 255.0
                    for i in imgs])
    return ((arr - mean) / std).transpose(0, 3, 1, 2).copy()


class OnnxEncoder:
    """Embeds with the same ONNX file the browser loads."""

    def __init__(self, variant='fp32', threads=0):
        import onnxruntime as ort
        opts = ort.SessionOptions()
        if threads:
            opts.intra_op_num_threads = threads
        self.path = MODEL_DIR / ('encoder_%s.onnx' % variant)
        self.sess = ort.InferenceSession(str(self.path), opts, providers=['CPUExecutionProvider'])
        self.name = 'dinov2-small-onnx-' + variant

    def embed(self, imgs, batch=32):
        out = []
        for i in range(0, len(imgs), batch):
            out.append(self.sess.run(None, {'pixel_values': preprocess(imgs[i:i + batch])})[0])
        v = np.concatenate(out).astype(np.float32)
        return v / np.linalg.norm(v, axis=1, keepdims=True)
