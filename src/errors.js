export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (message) => new ApiError(400, "validation_error", message);
export const unauthorized = (message = "请先登录") => new ApiError(401, "unauthenticated", message);
export const forbidden = (message = "无权执行此操作") => new ApiError(403, "forbidden", message);
export const notFound = (message = "资源不存在") => new ApiError(404, "not_found", message);
export const conflict = (code, message) => new ApiError(409, code, message);
