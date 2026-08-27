class ComfyUIError(RuntimeError):
    """Base error for the production ComfyUI adapter."""


class WorkflowPreparationError(ComfyUIError):
    """A Workflow Profile cannot safely prepare the base workflow."""


class ComfyUIConnectionError(ComfyUIError):
    """ComfyUI could not be reached for a connectivity operation."""


class ComfyUIProtocolError(ComfyUIError):
    """ComfyUI returned a response that does not match its expected protocol."""


class UploadError(ComfyUIError):
    """An input upload failed or returned an invalid response."""


class ExecutionObservationError(ComfyUIError):
    """The advisory ComfyUI WebSocket stream failed."""


class HistoryError(ComfyUIError):
    """Prompt history could not be retrieved or interpreted."""


class ArtifactDownloadError(ComfyUIError):
    """A remote ComfyUI artifact could not be downloaded."""
