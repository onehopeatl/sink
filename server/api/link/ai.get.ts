import { destr } from 'destr'
import { z } from 'zod'

defineRouteMeta({
  openAPI: {
    description: 'Generate a slug using AI based on the URL',
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: 'url',
        in: 'query',
        required: true,
        schema: { type: 'string', format: 'uri' },
        description: 'The URL to generate a slug for',
      },
    ],
  },
})

interface AiChatResponse {
  response?: string
  choices?: { message?: { content?: string } }[]
}

export default eventHandler(async (event) => {
  const url = (await getValidatedQuery(event, z.object({
    url: z.string().url(),
  }).parse)).url
  const { cloudflare } = event.context
  const { AI } = cloudflare.env

  if (!AI) {
    throw createError({ status: 501, statusText: 'AI not enabled' })
  }

  const { aiPrompt, aiModel } = useRuntimeConfig(event)
  const { slugRegex } = useAppConfig()

  const markdown = await fetchPageMarkdown(event, url, AI)
  const userContent = markdown
    ? `URL: ${url}\n\nPage content:\n${markdown}`
    : url

  const messages = [
    { role: 'system', content: aiPrompt.replace('{slugRegex}', slugRegex.toString()) },

    { role: 'user', content: 'https://www.cloudflare.com/' },
    { role: 'assistant', content: '{"slug": "cloudflare"}' },

    { role: 'user', content: 'https://github.com/nuxt/' },
    { role: 'assistant', content: '{"slug": "nuxt"}' },

    { role: 'user', content: 'https://sink.cool/' },
    { role: 'assistant', content: '{"slug": "sink-cool"}' },

    { role: 'user', content: 'https://github.com/miantiao-me/sink' },
    { role: 'assistant', content: '{"slug": "sink"}' },

    { role: 'user', content: userContent },
  ]

  const response = await AI.run(aiModel as keyof AiModels, {
    messages,
    chat_template_kwargs: {
      enable_thinking: false,
    },
  }) as AiChatResponse

  let content = response.response ?? response.choices?.[0]?.message?.content ?? ''

  // 1. Try to strip markdown code block wrapper (e.g. ```json\n{...}\n```)
  const codeBlockMatch = content.match(/```(?:json)?\n([\s\S]*?)```/)
  if (codeBlockMatch?.[1]) {
    content = codeBlockMatch[1].trim()
  }
  else {
    // 2. Try balanced brace extraction to handle trailing conversational text
    const firstBrace = content.indexOf('{')
    if (firstBrace !== -1) {
      let depth = 0
      for (let i = firstBrace; i < content.length; i++) {
        if (content[i] === '{') {
          depth++
        }
        else if (content[i] === '}') {
          depth--
          if (depth === 0) {
            content = content.substring(firstBrace, i + 1)
            break
          }
        }
      }
    }
  }

  let parsed = destr(content)

  // Ensure we always return an object with a slug property
  if (typeof parsed === 'string' || parsed === null) {
    // Try regex fallback if destr fails
    const slugMatch = content.match(/"slug"\s*:\s*"([^"]+)"/)
    if (slugMatch && slugMatch[1]) {
      parsed = { slug: slugMatch[1] }
    }
    else {
      // Last resort fallback: try to find anything that looks like a slug in the string
      const fallbackMatch = content.match(/[a-z0-9-]+/i)
      if (fallbackMatch && fallbackMatch[0] && content.length < 50) {
        parsed = { slug: fallbackMatch[0].toLowerCase() }
      }
      else {
        throw createError({
          statusCode: 500,
          statusMessage: 'Invalid AI response format',
        })
      }
    }
  }

  // Final validation of the parsed object
  const result = parsed as Record<string, any>
  if (typeof result !== 'object' || !result.slug) {
    throw createError({
      statusCode: 500,
      statusMessage: 'AI response missing slug property',
    })
  }

  return {
    slug: String(result.slug),
  }
})
