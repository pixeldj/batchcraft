class ApplicationError(RuntimeError):
    """The requested application operation cannot be completed safely."""


class RunNotFoundError(ApplicationError):
    pass


class ResultNotFoundError(ApplicationError):
    pass


class AssetNotFoundError(ApplicationError):
    pass


class AssetUploadError(ApplicationError):
    pass


class AssetDataError(ApplicationError):
    pass


class AssetPublicationError(ApplicationError):
    pass


class InvalidProjectKeyError(ApplicationError):
    pass


class ProjectPublicationError(ApplicationError):
    pass


class ProjectAdoptionError(ApplicationError):
    pass


class ProjectDiscoveryError(ApplicationError):
    pass


class ProjectImportError(ApplicationError):
    pass


class ProjectImportConflictError(ProjectImportError):
    pass


class SavedBatchPublicationError(ApplicationError):
    pass


class SavedBatchAdoptionError(ApplicationError):
    pass


class SavedBatchDiscoveryError(ApplicationError):
    pass


class SavedBatchOwnershipError(ApplicationError):
    pass


class SavedBatchRevisionConflictError(ApplicationError):
    pass


class RunDataError(ApplicationError):
    pass


class HistoricalResourceImportError(ApplicationError):
    pass


class HistoricalResourceImportConflictError(HistoricalResourceImportError):
    pass


class ProjectHistoryNotFoundError(ApplicationError):
    pass


class RunCreationError(ApplicationError):
    pass


class RunPublicationError(ApplicationError):
    pass


class ExecutionAlreadyActiveError(ApplicationError):
    pass


class ExecutionNotEligibleError(ApplicationError):
    pass


class RunDiscardNotEligibleError(ApplicationError):
    pass


class RunCancellationNotEligibleError(ApplicationError):
    pass


class RunCancellationStoreError(ApplicationError):
    pass
