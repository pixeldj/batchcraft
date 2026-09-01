import re
from typing import TypeGuard

IMAGE_INPUT_SLOT_KEY_PATTERN = re.compile(r"[a-z][a-z0-9]*(?:_[a-z0-9]+)*")
STABLE_KEY_PATTERN = IMAGE_INPUT_SLOT_KEY_PATTERN


def is_valid_image_input_slot_key(value: object) -> TypeGuard[str]:
    return isinstance(value, str) and IMAGE_INPUT_SLOT_KEY_PATTERN.fullmatch(value) is not None


def validate_image_input_slot_key(value: object) -> str:
    try:
        return validate_stable_key(value)
    except ValueError as error:
        raise ValueError(
            "image input slot key must be lowercase ASCII snake case and start with a letter"
        ) from error


def validate_stable_key(value: object) -> str:
    if not isinstance(value, str) or STABLE_KEY_PATTERN.fullmatch(value) is None:
        raise ValueError("key must be lowercase ASCII snake case and start with a letter")
    return value
