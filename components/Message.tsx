import type { ChatAddToolApproveResponseFunction, UIMessage } from 'ai';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { safeLinkUrl } from '@/lib/markdown';
import ToolCard, { type ToolPartLike } from './ToolCard';

export default function Message({
  message,
  onApproval,
}: {
  message: UIMessage;
  onApproval: ChatAddToolApproveResponseFunction;
}) {
  const isUser = message.role === 'user';
  return (
    <div className={isUser ? 'flex justify-end' : ''}>
      <div
        className={
          isUser
            ? 'max-w-[90%] whitespace-pre-wrap rounded-lg bg-blue-600 px-3 py-2 text-sm text-white'
            : 'w-full space-y-2 text-sm'
        }
      >
        {message.parts.map((part, i) => {
          if (part.type === 'text') {
            return isUser ? (
              <span key={i}>{part.text}</span>
            ) : (
              <div key={i} className="prose-chat break-words">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  urlTransform={safeLinkUrl}
                  components={{
                    a: ({ node: _node, ...props }) =>
                      props.href ? <a {...props} target="_blank" rel="noreferrer noopener" /> : <span>{props.children}</span>,
                    // Never fetch images from model output: rendering one is a zero-click exfiltration channel.
                    img: ({ alt }) => <span className="text-zinc-500">[image removed{alt ? `: ${alt}` : ''}]</span>,
                  }}
                >
                  {part.text}
                </ReactMarkdown>
              </div>
            );
          }
          if (part.type === 'reasoning') {
            if (!part.text.trim()) return null;
            return (
              <details key={i} className="text-xs text-zinc-500">
                <summary className="cursor-pointer select-none">Reasoning</summary>
                <div className="mt-1 whitespace-pre-wrap border-l-2 border-zinc-300 pl-2 dark:border-zinc-700">
                  {part.text}
                </div>
              </details>
            );
          }
          if (part.type.startsWith('tool-') || part.type === 'dynamic-tool') {
            return <ToolCard key={i} part={part as unknown as ToolPartLike} onApproval={onApproval} />;
          }
          return null;
        })}
      </div>
    </div>
  );
}
