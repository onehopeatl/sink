import { destr } from 'destr'
import { z } from 'zod'

defineRouteMeta({
  openAPI: {
    description: 'Generate OpenGraph title and description using AI based on the URL',
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: 'url',
        in: 'query',
        required: true,
        schema: { type: 'string', format: 'uri' },
        description: 'The URL to generate OpenGraph metadata for',
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

  const { aiOgPrompt, aiModel } = useRuntimeConfig(event)

  const markdown = await fetchPageMarkdown(event, url, AI)
  const userContent = markdown
    ? `URL: ${url}\n\nPage content:\n${markdown}`
    : url

  const messages = [
    { role: 'system', content: aiOgPrompt },

    { role: 'user', content: 'https://www.cloudflare.com/' },
    { role: 'assistant', content: '{"title": "Cloudflare", "description": "Cloudflare is a global network designed to make everything you connect to the Internet secure, private, fast, and reliable."}' },

    { role: 'user', content: 'https://github.com/nuxt/' },
    { role: 'assistant', content: '{"title": "Nuxt", "description": "Nuxt is an intuitive and extensible Vue framework for creating modern web applications."}' },

    { role: 'user', content: userContent },
  ]

  const response = await AI.run(aiModel as keyof AiModels, {
    messages,
  }) as AiChatResponse

  let content = response.response ?? response.choices?.[0]?.message?.content ?? ''

  if (!content || content.trim() === '') {
    console.error('AI OG response is empty. Fallback initiated.')
    try {
      const urlObj = new URL(url)
      const domain = urlObj.hostname.replace('www.', '')
      return {
        title: domain,
        description: `Short link for ${url}`,
      }
    }
    catch {
      return {
        title: 'Short Link',
        description: 'Check out this link on Sink.',
      }
    }
  }

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

  // Ensure we always return an object with title and description properties
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    // Attempt to extract title and description as best effort from the raw content
    // Check multiple common formats: JSON-like, YAML-like, or plain text labels
    const titlePatterns = [
      /"title"\s*:\s*"([^"]+)"/,
      /title:\s*([^\n]+)/i,
      /^title\s*=\s*(.*)/im,
      /<title>([^<]+)<\/title>/i,
    ]

    const descPatterns = [
      /"description"\s*:\s*"([^"]+)"/,
      /description:\s*([^\n]+)/i,
      /^description\s*=\s*(.*)/im,
    ]

    let extractedTitle = ''
    let extractedDesc = ''

    for (const pattern of titlePatterns) {
      const match = content.match(pattern)
      if (match?.[1]) {
        extractedTitle = match[1].replace(/^["']|["']$/g, '').trim()
        break
      }
    }

    for (const pattern of descPatterns) {
      const match = content.match(pattern)
      if (match?.[1]) {
        extractedDesc = match[1].replace(/^["']|["']$/g, '').trim()
        break
      }
    }

    if (extractedTitle || extractedDesc) {
      parsed = {
        title: extractedTitle || 'Link',
        description: extractedDesc || 'No description provided.',
      }
    }
    else {
      console.error('AI OG response parsing failed. Final content:', content)
      // Final fallback instead of throwing
      try {
        const urlObj = new URL(url)
        parsed = {
          title: urlObj.hostname,
          description: `Short link for ${url}`,
        }
      }
      catch {
        parsed = {
          title: 'Short Link',
          description: 'No metadata available.',
        }
      }
    }
  }

  // Final validation of the parsed object
  const result = parsed as Record<string, any>
  if (typeof result !== 'object' || !result.title || !result.description) {
    throw createError({
      statusCode: 500,
      statusMessage: 'AI response missing title or description property',
    })
  }

  return {
    title: String(result.title),
    description: String(result.description),
  }
})
