import math
import re
from dataclasses import dataclass
from decimal import Decimal

from batchcraft.domain.models import (
    MAX_SAFE_INTEGER,
    ParameterBinding,
    ParameterScalar,
    ParameterValueType,
    WorkflowParameter,
    validate_parameter_alternatives,
)

MAX_PARAMETER_RANGE_VALUES = 10_000
MAX_PARAMETER_RANGE_DECIMAL_LENGTH = 100
_SIMPLE_DECIMAL = re.compile(r"^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$")


@dataclass(frozen=True, slots=True)
class ParameterDecimalRange:
    start: str
    end: str
    step: str


@dataclass(frozen=True, slots=True)
class ParameterValuesIntent:
    parameter_key: str
    values: tuple[ParameterScalar | None, ...]
    mode: str = "values"


@dataclass(frozen=True, slots=True)
class ParameterRangeIntent:
    parameter_key: str
    include_base: bool
    range: ParameterDecimalRange
    mode: str = "range"


EditableParameterBinding = ParameterValuesIntent | ParameterRangeIntent


def materialize_parameter_bindings(
    parameters: tuple[WorkflowParameter, ...],
    intents: tuple[EditableParameterBinding, ...],
) -> tuple[ParameterBinding, ...]:
    parameters_by_key = {parameter.key: parameter for parameter in parameters}
    bindings: list[ParameterBinding] = []
    seen: set[str] = set()
    for intent in intents:
        if intent.parameter_key in seen:
            raise ValueError("parameter bindings must have unique parameter keys")
        seen.add(intent.parameter_key)
        parameter = parameters_by_key.get(intent.parameter_key)
        if parameter is None:
            raise ValueError(
                f"parameter binding references unknown parameter {intent.parameter_key!r}"
            )
        if isinstance(intent, ParameterValuesIntent):
            if intent.mode != "values":
                raise ValueError("explicit parameter intent must use values mode")
            validate_parameter_alternatives(intent.values)
            for value in intent.values:
                _validate_parameter_value(parameter, value)
            values = intent.values
        elif isinstance(intent, ParameterRangeIntent):
            if intent.mode != "range":
                raise ValueError("parameter range intent must use range mode")
            values = _materialize_range(parameter, intent)
        else:
            raise ValueError("parameter bindings must use values or range intent")
        bindings.append(ParameterBinding(intent.parameter_key, values))
    return tuple(bindings)


def _validate_parameter_value(parameter: WorkflowParameter, value: ParameterScalar | None) -> None:
    if value is None:
        return
    matches = {
        ParameterValueType.STRING: isinstance(value, str),
        ParameterValueType.INTEGER: isinstance(value, int) and not isinstance(value, bool),
        ParameterValueType.FLOAT: isinstance(value, (int, float)) and not isinstance(value, bool),
        ParameterValueType.BOOLEAN: isinstance(value, bool),
    }[parameter.value_type]
    if not matches:
        raise ValueError(
            f"parameter {parameter.key!r} must be {parameter.value_type.value} or null"
        )


def _materialize_range(
    parameter: WorkflowParameter, intent: ParameterRangeIntent
) -> tuple[ParameterScalar | None, ...]:
    if parameter.value_type in {ParameterValueType.STRING, ParameterValueType.BOOLEAN}:
        raise ValueError(
            f"parameter {parameter.key!r} cannot use a range because its type is "
            f"{parameter.value_type.value}"
        )
    start = _parse_decimal(intent.range.start, "start")
    end = _parse_decimal(intent.range.end, "end")
    step = _parse_decimal(intent.range.step, "step")
    scale = max(start[1], end[1], step[1])
    start_value = start[0] * 10 ** (scale - start[1])
    end_value = end[0] * 10 ** (scale - end[1])
    step_value = step[0] * 10 ** (scale - step[1])
    if step_value == 0:
        raise ValueError("parameter range step must not be zero")
    divisor = 10**scale
    if parameter.value_type is ParameterValueType.INTEGER and any(
        value % divisor for value in (start_value, end_value, step_value)
    ):
        raise ValueError("integer parameter ranges require integral start, end, and step")
    distance = end_value - start_value
    if distance != 0 and (distance > 0) != (step_value > 0):
        raise ValueError("parameter range step must move from start toward end")
    count = abs(distance) // abs(step_value) + 1
    if count > MAX_PARAMETER_RANGE_VALUES:
        raise ValueError(
            f"This range produces {count:,} values. Reduce the range or increase the step."
        )

    numeric: list[int | float] = []
    for index in range(count):
        scaled = start_value + index * step_value
        if parameter.value_type is ParameterValueType.INTEGER:
            value = scaled // divisor
            if not -MAX_SAFE_INTEGER <= value <= MAX_SAFE_INTEGER:
                raise ValueError(
                    f"integer parameter range values must be from {-MAX_SAFE_INTEGER} through "
                    f"{MAX_SAFE_INTEGER}"
                )
            numeric.append(value)
        else:
            decimal_text = _scaled_decimal_string(scaled, scale)
            value = float(decimal_text)
            if not math.isfinite(value) or Decimal(str(value)) != Decimal(decimal_text):
                raise ValueError(
                    "float parameter range values must round-trip through JSON without precision loss"
                )
            numeric.append(0.0 if value == 0 else value)
    values: tuple[ParameterScalar | None, ...] = tuple(numeric)
    if intent.include_base:
        values = (None, *values)
    validate_parameter_alternatives(values)
    return values


def _parse_decimal(value: str, part: str) -> tuple[int, int]:
    if not isinstance(value, str) or len(value) > MAX_PARAMETER_RANGE_DECIMAL_LENGTH:
        raise ValueError(
            f"parameter range {part} must be a decimal string of at most "
            f"{MAX_PARAMETER_RANGE_DECIMAL_LENGTH} characters"
        )
    if not _SIMPLE_DECIMAL.fullmatch(value):
        raise ValueError(f"parameter range {part} must be a simple finite decimal string")
    sign = -1 if value.startswith("-") else 1
    unsigned = value.removeprefix("+").removeprefix("-")
    whole, dot, fraction = unsigned.partition(".")
    digits = (whole or "0") + fraction
    return sign * int(digits), len(fraction) if dot else 0


def _scaled_decimal_string(value: int, scale: int) -> str:
    negative = value < 0
    digits = str(abs(value)).rjust(scale + 1, "0")
    text = digits if scale == 0 else f"{digits[:-scale]}.{digits[-scale:]}"
    return f"-{text}" if negative else text
