import re
from typing import TypeGuard

IMAGE_INPUT_SLOT_KEY_PATTERN = re.compile(r"[a-z][a-z0-9]*(?:_[a-z0-9]+)*")


def is_valid_image_input_slot_key(value: object) -> TypeGuard[str]:
    return isinstance(value, str) and IMAGE_INPUT_SLOT_KEY_PATTERN.fullmatch(value) is not None


def validate_image_input_slot_key(value: object) -> str:
    if not is_valid_image_input_slot_key(value):
        raise ValueError(
            "image input slot key must be lowercase ASCII snake case and start with a letter"
        )
    return value
