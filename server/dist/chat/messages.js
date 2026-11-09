/** Public message shape. Soft-deleted content is never returned to clients. */
export function toChatMessageView(message, projectId) {
    return {
        id: message.id,
        projectId,
        content: message.deletedAt ? '' : message.content,
        createdAt: message.createdAt.toISOString(),
        deletedAt: message.deletedAt ? message.deletedAt.toISOString() : null,
        sender: {
            id: message.sender.id,
            username: message.sender.username,
            avatarUrl: message.sender.avatarUrl,
        },
    };
}
