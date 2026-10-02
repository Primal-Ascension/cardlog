"""The two candidate image encoders, behind one interface.

Images are squashed to the model's square input rather than center-cropped:
a center crop would cut the top and bottom off a 63:88 card. Catalog scans
and photos go through the same preprocessing, so the squash is consistent.
"""
import numpy as np
import torch
from PIL import Image

DEVICE = 'cuda' if torch.cuda.is_available() else 'cpu'


class Encoder:
    name = ''
    size = 224
    mean = (0.485, 0.456, 0.406)
    std = (0.229, 0.224, 0.225)

    def _tensor(self, imgs):
        arr = np.stack([np.asarray(i.convert('RGB').resize((self.size, self.size), Image.BICUBIC),
                                   np.float32) / 255.0 for i in imgs])
        arr = (arr - np.array(self.mean, np.float32)) / np.array(self.std, np.float32)
        return torch.from_numpy(arr.transpose(0, 3, 1, 2)).to(DEVICE)

    @torch.inference_mode()
    def embed(self, imgs, batch=32):
        out = []
        for i in range(0, len(imgs), batch):
            v = self._forward(self._tensor(imgs[i:i + batch])).float()
            out.append(torch.nn.functional.normalize(v, dim=-1).cpu().numpy())
        return np.concatenate(out)

    def fp16_bytes(self):
        """Estimated encoder.onnx size at fp16: two bytes per parameter."""
        return 2 * sum(p.numel() for p in self.model_params())


class DinoV2Small(Encoder):
    name = 'dinov2-small'

    def __init__(self):
        from transformers import AutoModel
        self.model = AutoModel.from_pretrained('facebook/dinov2-small').to(DEVICE).eval()

    def _forward(self, x):
        return self.model(pixel_values=x).pooler_output  # CLS token after layernorm

    def model_params(self):
        return self.model.parameters()


class MobileClipS0(Encoder):
    name = 'mobileclip-s0'
    # open_clip has shipped S0 under different names across releases; the
    # first one this install knows wins, and evaluate.py reports which.
    CANDIDATES = [('MobileCLIP-S0', 'datacompdr'), ('MobileCLIP2-S0', 'dfndr2b')]

    def __init__(self):
        import open_clip
        available = set(open_clip.list_pretrained())
        for arch, tag in self.CANDIDATES:
            if (arch, tag) in available:
                break
        else:
            raise RuntimeError('No MobileCLIP-S0 weights in this open_clip install. '
                               'Known S-models: %s' % sorted(a for a in available if 'MobileCLIP' in a[0]))
        self.variant = '%s/%s' % (arch, tag)
        model, _, _ = open_clip.create_model_and_transforms(arch, pretrained=tag)
        self.model = model.to(DEVICE).eval()
        cfg = getattr(self.model.visual, 'preprocess_cfg', {}) or {}
        size = cfg.get('size') or self.model.visual.image_size
        self.size = size[0] if isinstance(size, (tuple, list)) else size
        self.mean = tuple(cfg.get('mean', (0.0, 0.0, 0.0)))
        self.std = tuple(cfg.get('std', (1.0, 1.0, 1.0)))

    def _forward(self, x):
        return self.model.encode_image(x)

    def model_params(self):
        return self.model.visual.parameters()


ENCODERS = {'dinov2-small': DinoV2Small, 'mobileclip-s0': MobileClipS0}
