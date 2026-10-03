"""Step 2: export the chosen encoder to ONNX for the browser and for catalog embedding.

Usage:  python encoder_export.py

Writes cache/model/encoder_fp32.onnx, encoder_fp16.onnx and encoder_int8.onnx.
The model takes pixel_values [N,3,224,224] (already normalized) and returns
L2-normalized embeddings [N,384], so the browser only has to take dot products.
Each export is checked against PyTorch on real card crops.
"""
import numpy as np
import onnx
import onnxruntime as ort
import torch
from PIL import Image

from config import ENCODER, IMAGES_DIR, MODEL_DIR
from embedder import preprocess, art_crop


class Wrapped(torch.nn.Module):
    def __init__(self, model):
        super().__init__()
        self.model = model
        # DINOv2 was trained at 518px and bicubic-resizes its position table on
        # every forward pass. The input size is fixed, so resize once here; HF
        # then uses the table directly and the exported graph has no Resize op.
        s, d = ENCODER['input_size'], ENCODER['dim']
        n = (s // 14) ** 2 + 1
        emb = model.embeddings
        with torch.no_grad():
            pe = emb.interpolate_pos_encoding(torch.zeros(1, n, d), s, s).clone()
        emb.position_embeddings = torch.nn.Parameter(pe)
        # HF skips its "already the right size" shortcut while tracing, so the
        # bicubic Resize would still be exported (and ORT WebGPU's bicubic
        # shader fails to compile). Return the baked table unconditionally.
        emb.interpolate_pos_encoding = lambda embeddings, height, width: emb.position_embeddings

    def forward(self, pixel_values):
        v = self.model(pixel_values=pixel_values).pooler_output
        return torch.nn.functional.normalize(v, dim=-1)


def sample_batch(n=16):
    paths = sorted((IMAGES_DIR / 'large').rglob('*.png'))[:: max(1, len(list((IMAGES_DIR / 'large').rglob('*.png'))) // n)][:n]
    return preprocess([art_crop(Image.open(p).convert('RGB')) for p in paths])


def check(path, x, ref):
    sess = ort.InferenceSession(str(path), providers=['CPUExecutionProvider'])
    out = sess.run(None, {'pixel_values': x})[0].astype(np.float32)
    cos = (out * ref).sum(1)
    print('  %-22s %6.1f MB  cosine vs torch: min %.5f  mean %.5f'
          % (path.name, path.stat().st_size / 1e6, cos.min(), cos.mean()))
    return cos.min()


def main():
    from transformers import AutoModel
    base = AutoModel.from_pretrained(ENCODER['hf_id']).eval()
    x = sample_batch()
    with torch.inference_mode():
        ref = torch.nn.functional.normalize(base(pixel_values=torch.from_numpy(x)).pooler_output, dim=-1).numpy()
    model = Wrapped(base)
    with torch.inference_mode():
        baked = model(torch.from_numpy(x)).numpy()
    print('baked position table vs original: min cosine %.6f' % (baked * ref).sum(1).min())

    fp32 = MODEL_DIR / 'encoder_fp32.onnx'
    s = ENCODER['input_size']
    torch.onnx.export(model, (torch.zeros(1, 3, s, s),), str(fp32),
                      input_names=['pixel_values'], output_names=['embedding'],
                      dynamic_axes={'pixel_values': {0: 'n'}, 'embedding': {0: 'n'}},
                      opset_version=18, dynamo=False)
    onnx.checker.check_model(str(fp32))

    # ORT's transformer optimizer handles the fp16 cast placement that the
    # generic onnxconverter-common pass gets wrong on the patch-embedding Conv.
    from onnxruntime.transformers.optimizer import optimize_model
    fp16 = MODEL_DIR / 'encoder_fp16.onnx'
    opt = optimize_model(str(fp32), model_type='vit', num_heads=6, hidden_size=ENCODER['dim'],
                         opt_level=0, use_gpu=False)
    opt.convert_float_to_float16(keep_io_types=True)
    opt.save_model_to_file(str(fp16))

    from onnxruntime.quantization import QuantType, quantize_dynamic
    int8 = MODEL_DIR / 'encoder_int8.onnx'
    quantize_dynamic(str(fp32), str(int8), weight_type=QuantType.QInt8)

    print('Exported (checked on %d real art crops):' % len(x))
    for p in (fp32, fp16, int8):
        check(p, x, ref)
        ops = sorted({n.op_type for n in onnx.load(str(p)).graph.node})
        if 'Resize' in ops:
            raise SystemExit('FAIL: %s still contains a Resize node' % p.name)
    print('ops in fp16 graph:', ', '.join(ops))


if __name__ == '__main__':
    main()
