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


class RunDataError(ApplicationError):
    pass


class RunCreationError(ApplicationError):
    pass


class RunPublicationError(ApplicationError):
    pass


class ExecutionAlreadyActiveError(ApplicationError):
    pass


class ExecutionNotEligibleError(ApplicationError):
    pass
